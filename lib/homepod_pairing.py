"""Pairing logic for HomePod and HomePod Mini.

HomePods use transient pairing (no PIN) — pyatv performs the HAP-over-IP
handshake automatically when pairing.begin() / pairing.finish() are called.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import TYPE_CHECKING

import pyatv
from pyatv.const import Protocol

if TYPE_CHECKING:
    import homey

logger = logging.getLogger(__name__)

DISCOVER_RETRIES = 5
DISCOVER_RETRY_INTERVAL = 1.0  # seconds


class HomePodBasePairing:
    def __init__(
        self,
        session: homey.Driver.PairSession,
        model_filter: re.Pattern,
        known_devices: list,
        homey: homey.Homey,
    ) -> None:
        self._session = session
        self._model_filter = model_filter
        self._known_devices = known_devices
        self._homey = homey
        self._devices: list = []
        self._selected_device = None

    async def start(self) -> None:
        await self._load_devices()

        self._session.set_handler('show_view', self._on_show_view)
        self._session.set_handler('list_devices', self._on_list_devices)
        self._session.set_handler('list_devices_selection', self._on_list_devices_selection)
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
        known_ids = {d.get_data().get('id') for d in self._known_devices}
        return [
            d for d in self._devices
            if d.identifier not in known_ids
            and self._model_filter.search(d.properties.get('model', ''))
        ]

    async def _on_list_devices_selection(self, devices: list) -> None:
        if devices:
            self._selected_device = devices[-1]

    async def _on_get_device(self) -> dict | None:
        if not self._selected_device:
            return None

        return {
            'name': self._selected_device.name,
            'data': {
                'id': self._selected_device.identifier,
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
        pairing = await pyatv.pair(self._selected_device, Protocol.AirPlay, loop)

        try:
            await pairing.begin()
            # HomePod uses transient pairing — no PIN required
            await pairing.finish()

            if pairing.has_paired:
                credentials = pairing.service.credentials
                # Store credentials in the device object so get_device can persist them
                self._selected_device._credentials = credentials
                logger.info(f'Paired with HomePod: {self._selected_device.name}')
                await self._session.show_view('add_my_device')
            else:
                logger.error('HomePod pairing did not complete successfully.')
        finally:
            await pairing.close()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _load_devices(self) -> None:
        loop = asyncio.get_running_loop()
        results = await pyatv.scan(loop, timeout=5)
        self._devices = results
