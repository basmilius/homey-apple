from __future__ import annotations

import re
from typing import Any

from ..base.pairing import BasePairing


class HomePodBasePairing(BasePairing):
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
        super().__init__(session, strategy, known_devices)
        self._model_filter = model_filter
        self._store: dict[str, Any] = {}

    def _is_supported_model(self, model: str | None) -> bool:
        return model is not None and bool(self._model_filter.search(model))

    async def _get_device(self, _: Any = None) -> dict:
        device = self._selected_device
        if device is None:
            return {}
        return {
            "name": getattr(device, "name", None),
            "data": {"id": getattr(device, "id", None)},
            "store": dict(self._store),
        }

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

        self._store = {
            "id": str(getattr(device, "id", "")),
            "address": str(address),
            "port": port,
            "model": model,
        }

        await self._session.show_view("add_my_device")
