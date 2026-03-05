from __future__ import annotations

import asyncio
import ipaddress
from typing import Any
from collections.abc import Mapping

import pyatv
import pyatv.interface as pyatv_interface
from pyatv.conf import AppleTV as PyATVConfig, ManualService
from pyatv.const import Protocol

from ..utils.wait_for import wait_for


class AppleTVPairing:
    """
    Manages the pairing flow for Apple TV devices.

    Pairing uses the AirPlay HAP protocol.  The user is shown a PIN on their
    Apple TV which they enter in the Homey pairing UI.
    """

    def __init__(
        self,
        session: Any,
        strategy: Any,
        known_devices: list,
    ) -> None:
        self._session = session
        self._strategy = strategy
        self._known_devices = known_devices
        self._devices: list = list(strategy.get_discovery_results().values())
        self._selected_device: Any = None
        self._pairing_handler: pyatv_interface.PairingHandler | None = None

        self.on_log: Any = None
        self.on_error: Any = None

        # Listen for newly discovered devices during the pairing flow (avoid duplicates)
        def _on_result(r: Any) -> None:
            try:
                rid = getattr(r, "id", None)
                if rid and any(getattr(d, "id", None) == rid for d in self._devices):
                    return
            except Exception:
                pass
            self._devices.append(r)

        strategy.on("result", _on_result)

    def _txt_to_str_dict(self, txt: Any) -> dict[str, str]:
        if not isinstance(txt, Mapping):
            return {}
        out: dict[str, str] = {}
        for k, v in txt.items():
            try:
                ks = k.decode("utf-8", "ignore") if isinstance(k, (bytes, bytearray)) else str(k)
                vs = v.decode("utf-8", "ignore") if isinstance(v, (bytes, bytearray)) else str(v)
                out[ks] = vs
            except Exception:
                continue
        return out

    async def start(self) -> None:
        self._session.set_handler("showView", self._on_show_view)

        async def _list_devices_handler(_: Any = None) -> list[dict]:
            return await self._list_devices()

        self._session.set_handler("list_devices", _list_devices_handler)
        self._session.set_handler("list_devices_selection", self._on_device_selected)
        self._session.set_handler("pincode", self._on_pincode)
        self._session.set_handler("get_device", self._get_device)

    async def _list_devices(self) -> list[dict]:
        known_ids = set()
        for d in self._known_devices:
            try:
                data = d.get_data() or {}
                if data.get("id"):
                    known_ids.add(data["id"])
            except Exception:
                continue

        entries: list[dict] = []
        for r in sorted(self._devices, key=lambda x: (getattr(x, "name", "") or "").lower()):
            try:
                rid = getattr(r, "id", None)
                if not rid or rid in known_ids:
                    continue

                txt = self._txt_to_str_dict(getattr(r, "txt", None))
                model = txt.get("model", "")
                if not model.startswith("AppleTV"):
                    continue

                entries.append({"id": rid, "name": getattr(r, "name", None), "data": {"id": rid}})
            except Exception:
                continue

        return entries

    async def _on_device_selected(self, devices: list) -> None:
        if devices:
            last = devices[-1]
            device_id = last.get("data", {}).get("id") if isinstance(last, dict) else getattr(last, "id", None)
            self._selected_device = next((r for r in self._devices if getattr(r, "id", None) == device_id), None)

    async def _on_pincode(self, code: Any) -> Any:
        if self._pairing_handler is None:
            return None

        pin = "".join(str(b) for b in code) if isinstance(code, (list, bytes)) else str(code)

        if self.on_log:
            # Don't log the PIN itself (it ends up in logs / support bundles).
            self.on_log(f'Pairing to {getattr(self._selected_device, "name", "?")} with PIN (redacted)')

        self._pairing_handler.pin(int(pin))

        finish_error: Exception | None = None
        try:
            await self._pairing_handler.finish()
        except Exception as err:
            finish_error = err

        # PyATV may still have produced credentials even if finish() raised.
        credentials = getattr(getattr(self._pairing_handler, "service", None), "credentials", None)

        if finish_error is not None and not credentials:
            if self.on_error:
                self.on_error(finish_error)
            return False

        if finish_error is not None and credentials and self.on_log:
            self.on_log(f"Pairing reported an error, but credentials were received; continuing ({type(finish_error).__name__}).")

        self._selected_device._pyatv_credentials = credentials

        # await self._session.show_view("add_my_device")
        await self._pairing_handler.close()

        return True

    async def _get_device(self, _: Any = None) -> dict:
        device = self._selected_device
        if device is None:
            return {}

        credentials = getattr(device, "_pyatv_credentials", None)
        return {
            "name": getattr(device, "name", None),
            "data": {"id": getattr(device, "id", None)},
            "store": {
                "id": getattr(device, "id", None),
                "airplay_credentials": credentials,
            },
        }

    async def _on_show_view(self, view: str) -> None:
        try:
            if view == "authenticate":
                await self._on_show_view_authenticate()
            elif view == "discover":
                await self._on_show_view_discover()
        except Exception as err:
            if self.on_error:
                self.on_error(err)

    async def _on_show_view_authenticate(self) -> None:
        if self._selected_device is None:
            await self._session.show_view("list_devices")
            if self.on_error:
                self.on_error("No device selected.")
            return

        device = self._selected_device
        if self.on_log:
            self.on_log(f"Connecting to {device.address}:{device.port} for pairing...")

        loop = asyncio.get_event_loop()
        config = PyATVConfig(
            address=ipaddress.IPv4Address(device.address),
            name=device.name or "",
        )
        config.add_service(
            ManualService(
                identifier=device.id,
                protocol=Protocol.AirPlay,
                port=device.port,
                properties=dict(getattr(device, "txt", {}) or {}),
            )
        )

        self._pairing_handler = await pyatv.pair(config, Protocol.AirPlay, loop)
        await self._pairing_handler.begin()

    async def _on_show_view_discover(self) -> None:
        for _ in range(10):
            pairable = await self._list_devices()
            if pairable:
                await self._session.show_view("list_devices")
                return
            await wait_for(500)

        await self._session.show_view("list_devices")
