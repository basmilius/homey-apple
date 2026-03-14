from __future__ import annotations

import asyncio
import ipaddress
from typing import Any

import pyatv
import pyatv.interface as pyatv_interface
from pyatv.conf import AppleTV as PyATVConfig, ManualService
from pyatv.const import Protocol

from ..base.pairing import BasePairing


class AppleTVPairing(BasePairing):
    """
    Manages the pairing flow for Apple TV devices.

    Pairing uses the AirPlay HAP protocol.  The user is shown a PIN on their
    Apple TV which they enter in the Homey pairing UI.  The resulting
    credentials are used for both AirPlay and Companion protocols.
    """

    def __init__(
        self,
        session: Any,
        strategy: Any,
        known_devices: list,
    ) -> None:
        super().__init__(session, strategy, known_devices)
        self._pairing_handler: pyatv_interface.PairingHandler | None = None
        self._credentials: str | None = None

    def _is_supported_model(self, model: str | None) -> bool:
        return model is not None and model.startswith("AppleTV")

    async def start(self) -> None:
        await super().start()
        self._session.set_handler("pincode", self._on_pincode)

    async def _on_pincode(self, code: Any) -> Any:
        if self._pairing_handler is None:
            return None

        if isinstance(code, bytes):
            pin = code.decode('utf-8', 'ignore')
        elif isinstance(code, list):
            pin = "".join(str(b) for b in code)
        else:
            pin = str(code)

        if self.on_log:
            self.on_log(f'Pairing to {getattr(self._selected_device, "name", "?")} with PIN (redacted)')

        pin = pin.strip()
        try:
            pin_int = int(pin)
        except ValueError as err:
            if self.on_error:
                self.on_error(f'Invalid PIN format: {err}')
            return False

        self._pairing_handler.pin(pin_int)

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
            await self._pairing_handler.close()
            return False

        if finish_error is not None and credentials and self.on_log:
            self.on_log(f"Pairing reported an error, but credentials were received; continuing ({type(finish_error).__name__}).")

        self._credentials = credentials

        await self._pairing_handler.close()

        return True

    async def _get_device(self, _: Any = None) -> dict:
        device = self._selected_device
        if device is None:
            return {}

        return {
            "name": getattr(device, "name", None),
            "data": {"id": getattr(device, "id", None)},
            "store": {
                "id": getattr(device, "id", None),
                "airplay_credentials": self._credentials,
            },
        }

    async def _on_show_view_authenticate(self) -> None:
        if self._selected_device is None:
            await self._session.show_view("list_devices")
            if self.on_error:
                self.on_error("No device selected.")
            return

        device = self._selected_device
        if self.on_log:
            self.on_log(f"Connecting to {device.address}:{device.port} for pairing...")

        loop = asyncio.get_running_loop()
        config = PyATVConfig(
            address=ipaddress.ip_address(device.address),
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
