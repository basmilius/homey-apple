from __future__ import annotations

import asyncio
import ipaddress
import re
from typing import Any
from collections.abc import Mapping

import pyatv
import pyatv.interface as pyatv_interface
from pyatv.conf import AppleTV as PyATVConfig, ManualService
from pyatv.const import Protocol
from pyatv.auth.hap_pairing import TRANSIENT_CREDENTIALS

from ..utils.wait_for import wait_for


class HomePodBasePairing:
    """
    Manages the pairing flow for HomePod and HomePod Mini.

    HomePod devices use AirPlay transient pairing – no PIN is required and
    no persistent credentials are stored.
    """

    def __init__(
        self,
        session: Any,
        strategy: Any,
        model_filter: re.Pattern,
        known_devices: list,
    ) -> None:
        self._session = session
        self._strategy = strategy
        self._model_filter = model_filter
        self._known_devices = known_devices
        self._devices: list = list(strategy.get_discovery_results().values())
        self._selected_device: Any = None
        self._store: dict[str, Any] = {}

        self.on_log: Any = None
        self.on_error: Any = None

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
                model = txt.get("model")
                if not model or not self._model_filter.search(model):
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

    async def _get_device(self, _: Any = None) -> dict:
        device = self._selected_device
        if device is None:
            return {}
        return {
            "name": getattr(device, "name", None),
            "data": {"id": getattr(device, "id", None)},
            "store": dict(self._store),
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
        txt = self._txt_to_str_dict(getattr(device, "txt", None))
        model = txt.get("model")

        if self.on_log:
            self.on_log(f"Using transient credentials for {getattr(device, 'name', '')} ({model or 'unknown model'}).")

        address = getattr(device, "address", None)
        if not address:
            raise RuntimeError("Selected device has no address; cannot continue.")

        port = int(getattr(device, "port", None) or 7000)

        # HomePod pairing: no PIN, store transient credentials.
        self._store = {
            "id": str(getattr(device, "id", "")),
            "address": str(address),
            "port": port,
            "protocol": "Protocol.AirPlay",
            "credentials": str(TRANSIENT_CREDENTIALS),
            "credentials_type": "transient",
            "model": model,
        }

        await self._session.show_view("add_my_device")

    async def _on_show_view_discover(self) -> None:
        for _ in range(10):
            pairable = await self._list_devices()
            if pairable:
                await self._session.show_view("list_devices")
                return
            await wait_for(500)

        await self._session.show_view("list_devices")
