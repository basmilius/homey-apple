from __future__ import annotations

from abc import abstractmethod
from collections.abc import Callable, Mapping
from typing import Any

from ..utils.wait_for import wait_for


class BasePairing:
    """
    Base class for device pairing flows.

    Provides shared logic for device discovery, selection, and view handling.
    Subclasses implement model filtering and authentication behavior.
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

        self.on_log: Callable[[str], None] | None = None
        self.on_error: Callable[[Any], None] | None = None

        def _on_result(result: Any) -> None:
            try:
                rid = getattr(result, "id", None)
                if rid and any(getattr(d, "id", None) == rid for d in self._devices):
                    return
            except Exception:
                pass
            self._devices.append(result)

        strategy.on("result", _on_result)

    @staticmethod
    def _txt_to_str_dict(txt: Any) -> dict[str, str]:
        """Convert mDNS TXT record bytes to a string dict."""
        if not isinstance(txt, Mapping):
            return {}
        out: dict[str, str] = {}
        for key, value in txt.items():
            try:
                ks = key.decode("utf-8", "ignore") if isinstance(key, (bytes, bytearray)) else str(key)
                vs = value.decode("utf-8", "ignore") if isinstance(value, (bytes, bytearray)) else str(value)
                out[ks] = vs
            except Exception:
                continue
        return out

    @abstractmethod
    def _is_supported_model(self, model: str | None) -> bool:
        """Return True if the model string matches this device type."""

    @abstractmethod
    async def _get_device(self, _: Any = None) -> dict:
        """Return the device dict for Homey to create the device."""

    @abstractmethod
    async def _on_show_view_authenticate(self) -> None:
        """Handle the authenticate view."""

    async def start(self) -> None:
        """Register pairing session handlers."""
        self._session.set_handler("showView", self._on_show_view)

        async def _list_devices_handler(_: Any = None) -> list[dict]:
            return await self._list_devices()

        self._session.set_handler("list_devices", _list_devices_handler)
        self._session.set_handler("list_devices_selection", self._on_device_selected)
        self._session.set_handler("get_device", self._get_device)

    async def _list_devices(self) -> list[dict]:
        """List discovered devices that are not yet paired."""
        known_ids = set()
        for device in self._known_devices:
            try:
                data = device.get_data() or {}
                if data.get("id"):
                    known_ids.add(data["id"])
            except Exception:
                continue

        entries: list[dict] = []
        for result in sorted(self._devices, key=lambda x: (getattr(x, "name", "") or "").lower()):
            try:
                rid = getattr(result, "id", None)
                if not rid or rid in known_ids:
                    continue

                txt = self._txt_to_str_dict(getattr(result, "txt", None))
                model = txt.get("model")
                if not self._is_supported_model(model):
                    continue

                entries.append({"id": rid, "name": getattr(result, "name", None), "data": {"id": rid}})
            except Exception:
                continue

        return entries

    async def _on_device_selected(self, devices: list) -> None:
        """Handle device selection from the pairing list."""
        if devices:
            last = devices[-1]
            device_id = last.get("data", {}).get("id") if isinstance(last, dict) else getattr(last, "id", None)
            self._selected_device = next(
                (r for r in self._devices if getattr(r, "id", None) == device_id),
                None,
            )

    async def _on_show_view(self, view: str) -> None:
        """Dispatch view events to the appropriate handler."""
        try:
            if view == "authenticate":
                await self._on_show_view_authenticate()
            elif view == "discover":
                await self._on_show_view_discover()
        except Exception as err:
            if self.on_error:
                self.on_error(err)

    async def _on_show_view_discover(self) -> None:
        """Wait for devices to appear and show the list."""
        for _ in range(10):
            pairable = await self._list_devices()
            if pairable:
                await self._session.show_view("list_devices")
                return
            await wait_for(500)

        await self._session.show_view("list_devices")
