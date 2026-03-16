from __future__ import annotations

import asyncio
import ipaddress
from typing import Any

import pyatv
import pyatv.interface as pyatv_interface
from pyatv.conf import AppleTV as PyATVConfig, ManualService
from pyatv.const import PairingRequirement, Protocol

from ..base.discoverable_device import SCAN_TIMEOUT_S
from ..base.pairing import BasePairing
from ..utils.mac_address import extract_mac_from_txt

DEFAULT_PAIRING_PIN = 1234
PIN_ENTRY_TIMEOUT_S = 120


class AppleTVPairing(BasePairing):
    """
    Manages the pairing flow for Apple TV devices.

    Pairing scans the device for all available protocols and pairs each
    one sequentially.  Protocols where the device provides a PIN (AirPlay,
    Companion, MRP) show a PIN-entry view for the user.  Protocols where
    the client provides the PIN (DMAP) use a default PIN of 1234.

    Credentials are stored via pyatv's storage backend.
    """

    def __init__(
        self,
        session: Any,
        strategy: Any,
        known_devices: list,
    ) -> None:
        super().__init__(session, strategy, known_devices)
        self._mac: str | None = None
        self._scan_config: pyatv_interface.BaseConfig | None = None
        self._credentials: str | None = None

        # Multi-protocol pairing state.
        self._pairing_handler: pyatv_interface.PairingHandler | None = None
        self._pin_future: asyncio.Future[bool] | None = None

    def _is_supported_model(self, model: str | None) -> bool:
        return model is not None and model.startswith("AppleTV")

    async def start(self) -> None:
        await super().start()
        self._session.set_handler("pincode", self._on_pincode)

    async def _on_show_view(self, view: str) -> None:
        """Dispatch view events, including the connect_device view."""
        try:
            if view == "connect_device":
                await self._on_show_view_connect_device()
            elif view == "authenticate":
                await self._on_show_view_authenticate()
            elif view == "discover":
                await self._on_show_view_discover()
        except Exception as err:
            if self.on_error:
                self.on_error(err)
            raise

    # ------------------------------------------------------------------
    # Connect & scan
    # ------------------------------------------------------------------

    async def _on_show_view_connect_device(self) -> None:
        """Scan the selected device and start multi-protocol pairing."""
        if self._selected_device is None:
            await self._session.show_view("list_devices")
            if self.on_error:
                self.on_error("No device selected.")
            return

        device = self._selected_device
        address = getattr(device, "address", None)

        if not address:
            if self.on_error:
                self.on_error("Device has no address; cannot pair.")
            await self._session.show_view("list_devices")
            return

        # Extract MAC address from TXT records.
        txt = self._txt_to_str_dict(getattr(device, "txt", None))
        self._mac = extract_mac_from_txt(txt)

        if self.on_log:
            self.on_log(f"Scanning {address} for protocols... (MAC: {self._mac or 'unknown'})")

        from ..app import AppleApp
        app = AppleApp._instance
        storage = app.storage if app is not None else None

        loop = asyncio.get_running_loop()

        # Full scan with identifier + hosts for complete protocol discovery.
        scan_kwargs: dict[str, Any] = {
            "timeout": SCAN_TIMEOUT_S,
            "hosts": [str(address)],
        }
        if self._mac:
            scan_kwargs["identifier"] = self._mac
        if storage is not None:
            scan_kwargs["storage"] = storage

        results = await pyatv.scan(loop, **scan_kwargs)
        if not results:
            # Fallback: manual config for AirPlay-only pairing.
            if self.on_log:
                self.on_log("Full scan returned no results, falling back to manual config.")

            port = getattr(device, "port", None)
            config = PyATVConfig(
                address=ipaddress.ip_address(str(address)),
                name=getattr(device, "name", None) or "",
            )
            config.add_service(
                ManualService(
                    identifier=getattr(device, "id", None),
                    protocol=Protocol.AirPlay,
                    port=int(port or 7000),
                    properties=dict(getattr(device, "txt", {}) or {}),
                )
            )
        else:
            config = results[0]
            if storage is not None:
                await storage.save()

        # Clear stale storage config for this device before pairing.
        if storage is not None:
            try:
                settings = await storage.get_settings(config)
                await storage.remove_settings(settings)
                await storage.save()
            except Exception:
                pass

        self._scan_config = config

        # Start pairing all protocols.
        await self._pair_all_protocols()

    # ------------------------------------------------------------------
    # Multi-protocol pairing
    # ------------------------------------------------------------------

    async def _pair_all_protocols(self) -> None:
        """Pair all discovered protocols sequentially.

        For each protocol that requires pairing, starts a pairing session.
        If the device provides a PIN, a pincode view is shown and the
        code waits for user input.  Otherwise a default PIN is used.
        After all protocols are paired, the add_my_device view is shown.
        """
        config = self._scan_config
        if config is None:
            return

        from ..app import AppleApp
        app = AppleApp._instance
        storage = app.storage if app is not None else None
        loop = asyncio.get_running_loop()

        for service in config.services:
            # Skip protocols that can't or don't need to be paired.
            if service.pairing in (PairingRequirement.Unsupported, PairingRequirement.Disabled, PairingRequirement.NotNeeded):
                if self.on_log:
                    self.on_log(f"Skipping {service.protocol.name} ({service.pairing.name}).")
                continue

            # Skip protocols that already have credentials.
            if service.credentials is not None:
                if self.on_log:
                    self.on_log(f"Skipping {service.protocol.name} (already paired).")
                continue

            if self.on_log:
                self.on_log(f"Pairing {service.protocol.name}...")

            try:
                self._pairing_handler = await pyatv.pair(
                    config, service.protocol, loop, storage=storage,
                )
                await self._pairing_handler.begin()

                if self._pairing_handler.device_provides_pin:
                    # Device shows a PIN — show the pincode view and wait
                    # for the user to enter it.
                    paired = await self._wait_for_pin()
                    if not paired:
                        if self.on_log:
                            self.on_log(f"Failed to pair {service.protocol.name} (invalid PIN).")
                        continue
                else:
                    # Client provides PIN — use default.
                    self._pairing_handler.pin(DEFAULT_PAIRING_PIN)
                    await self._pairing_handler.finish()

                # Capture AirPlay credentials for backward-compatible store.
                if service.protocol == Protocol.AirPlay:
                    self._credentials = getattr(
                        getattr(self._pairing_handler, "service", None),
                        "credentials", None,
                    )

                if self.on_log:
                    self.on_log(f"Paired {service.protocol.name} successfully.")
            except Exception as err:
                if self.on_log:
                    self.on_log(f"Failed to pair {service.protocol.name}: {err}")

                # Capture AirPlay credentials even on error (pyatv may have produced them).
                if service.protocol == Protocol.AirPlay:
                    self._credentials = getattr(
                        getattr(self._pairing_handler, "service", None),
                        "credentials", None,
                    )
            finally:
                await self._close_pairing_handler()

            # Save storage after each protocol.
            if storage is not None:
                try:
                    await storage.save()
                except Exception:
                    pass

        # All protocols done — proceed to device creation.
        await self._session.show_view("add_my_device")

    async def _wait_for_pin(self) -> bool:
        """Show the pincode view and wait for the user to enter a PIN.

        Returns True if pairing succeeded, False otherwise.
        Times out after :data:`PIN_ENTRY_TIMEOUT_S` seconds.
        """
        self._pin_future = asyncio.get_running_loop().create_future()
        await self._session.show_view("pair_protocol_pincode")

        try:
            return await asyncio.wait_for(self._pin_future, timeout=PIN_ENTRY_TIMEOUT_S)
        except asyncio.TimeoutError:
            if self.on_log:
                self.on_log("PIN entry timed out.")
            return False

    # ------------------------------------------------------------------
    # PIN code handler
    # ------------------------------------------------------------------

    async def _on_pincode(self, code: Any) -> Any:
        """Handle a pincode submitted by the user."""
        if self._pairing_handler is None:
            return None

        if isinstance(code, bytes):
            pin = code.decode('utf-8', 'ignore')
        elif isinstance(code, list):
            pin = "".join(str(b) for b in code)
        else:
            pin = str(code)

        if self.on_log:
            self.on_log(f'Received PIN for {getattr(self._selected_device, "name", "?")} (redacted)')

        pin = pin.strip()
        try:
            pin_int = int(pin)
        except ValueError as err:
            if self.on_error:
                self.on_error(f'Invalid PIN format: {err}')
            return False

        try:
            self._pairing_handler.pin(pin_int)
        except Exception as err:
            if self.on_error:
                self.on_error(f'Failed to set PIN: {err}')
            if self._pin_future and not self._pin_future.done():
                self._pin_future.set_result(False)
            return False

        try:
            await self._pairing_handler.finish()
        except Exception as err:
            # PyATV may still have produced credentials even if finish() raised.
            credentials = getattr(getattr(self._pairing_handler, "service", None), "credentials", None)

            if not credentials:
                if self.on_error:
                    self.on_error(err)
                if self._pin_future and not self._pin_future.done():
                    self._pin_future.set_result(False)
                return False

            if self.on_log:
                self.on_log(f"Pairing reported an error, but credentials were received; continuing ({type(err).__name__}).")

        if self._pin_future and not self._pin_future.done():
            self._pin_future.set_result(True)

        return True

    # ------------------------------------------------------------------
    # Device creation
    # ------------------------------------------------------------------

    async def _get_device(self, _: Any = None) -> dict:
        device = self._selected_device
        if device is None:
            return {}

        device_id = self._mac or getattr(device, "id", None)

        return {
            "name": getattr(device, "name", None),
            "data": {"id": device_id},
            "store": {
                "id": getattr(device, "id", None),
                "airplay_credentials": self._credentials,
            },
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _close_pairing_handler(self) -> None:
        """Close the pairing handler if it exists."""
        if self._pairing_handler is not None:
            try:
                await self._pairing_handler.close()
            except Exception:
                pass
            self._pairing_handler = None

    async def _on_show_view_authenticate(self) -> None:
        """Legacy view — redirect to connect_device flow."""
        await self._on_show_view_connect_device()
