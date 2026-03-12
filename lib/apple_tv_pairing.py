"""Apple TV pairing — PIN-based AirPlay pairing via pyatv."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import pyatv
from pyatv.const import Protocol

if TYPE_CHECKING:
    import homey

logger = logging.getLogger(__name__)

DISCOVER_RETRIES = 5
DISCOVER_RETRY_INTERVAL = 1.0  # seconds
APPLE_TV_MODEL_PATTERN = r'AppleTV\d+,\d+'


class AppleTVPairing:
    def __init__(
        self,
        session: homey.Driver.PairSession,
        known_devices: list,
        homey: homey.Homey,
    ) -> None:
        self._session = session
        self._known_devices = known_devices
        self._homey = homey
        self._devices: list = []
        self._selected_device = None
        self._pairing = None

    async def start(self) -> None:
        await self._load_devices()

        self._session.set_handler('show_view', self._on_show_view)
        self._session.set_handler('list_devices', self._on_list_devices)
        self._session.set_handler('list_devices_selection', self._on_list_devices_selection)
        self._session.set_handler('pincode', self._on_pincode)
        self._session.set_handler('get_device', self._on_get_device)

    # ------------------------------------------------------------------
    # Session handlers
    # ------------------------------------------------------------------

    async def _on_show_view(self, view: str) -> None:
        try:
            if view == 'discover':
                await self._on_show_view_discover()
            elif view == 'authenticate':
                await self._on_show_view_authenticate()
        except Exception as err:
            logger.error(f'Error in pairing view {view}: {err}')

    async def _on_list_devices(self) -> list:
        import re
        known_ids = {d.get_data().get('id') for d in self._known_devices}
        pattern = re.compile(APPLE_TV_MODEL_PATTERN)
        return sorted(
            [
                d for d in self._devices
                if d.identifier not in known_ids
                and pattern.search(d.properties.get('model', ''))
            ],
            key=lambda d: d.name,
        )

    async def _on_list_devices_selection(self, devices: list) -> None:
        if devices:
            self._selected_device = devices[-1]

    async def _on_pincode(self, code) -> None:
        """Receive the 4-digit PIN entered by the user and complete pairing."""
        if self._pairing is None:
            logger.error('PIN received but pairing object is not initialized.')
            return

        # code may arrive as a list of ints or a string
        if isinstance(code, (list, tuple)):
            pin = ''.join(str(c) for c in code)
        else:
            pin = str(code)

        logger.info(f'Pairing to {self._selected_device.name} with PIN {pin}')
        self._pairing.pin(pin)
        await self._pairing.finish()

        if self._pairing.has_paired:
            credentials = self._pairing.service.credentials
            self._selected_device._credentials = credentials
            logger.info(f'Successfully paired with Apple TV: {self._selected_device.name}')
            await self._session.show_view('add_my_device')
        else:
            logger.error('Pairing did not complete successfully — wrong PIN?')

        await self._pairing.close()
        self._pairing = None

    async def _on_get_device(self) -> dict | None:
        if not self._selected_device:
            return None

        credentials = getattr(self._selected_device, '_credentials', None)

        return {
            'name': self._selected_device.name,
            'data': {
                'id': self._selected_device.identifier,
            },
            'store': {
                'id': self._selected_device.identifier,
                'credentials': credentials,
            },
        }

    # ------------------------------------------------------------------
    # View handlers
    # ------------------------------------------------------------------

    async def _on_show_view_discover(self) -> None:
        for _ in range(DISCOVER_RETRIES):
            if self._devices:
                break
            await asyncio.sleep(DISCOVER_RETRY_INTERVAL)
            await self._load_devices()

        await self._session.show_view('list_devices')

    async def _on_show_view_authenticate(self) -> None:
        if not self._selected_device:
            await self._session.show_view('list_devices')
            return

        loop = asyncio.get_running_loop()
        self._pairing = await pyatv.pair(self._selected_device, Protocol.AirPlay, loop)
        await self._pairing.begin()
        # The PIN will be entered by the user; _on_pincode will finish the pairing.

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _load_devices(self) -> None:
        loop = asyncio.get_running_loop()
        results = await pyatv.scan(loop, timeout=5)
        self._devices = results
