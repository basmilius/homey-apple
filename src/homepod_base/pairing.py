from __future__ import annotations

import asyncio
import ipaddress
import re
from typing import Any

import pyatv
import pyatv.interface as pyatv_interface
from pyatv.conf import AppleTV as PyATVConfig, ManualService
from pyatv.const import Protocol

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

        self.on_log: Any = None
        self.on_error: Any = None

        strategy.on('result', lambda r: self._devices.append(r))

    async def start(self) -> None:
        self._session.set_handler('showView', self._on_show_view)
        self._session.set_handler('list_devices', lambda _=None: self._list_devices())
        self._session.set_handler('list_devices_selection', self._on_device_selected)
        self._session.set_handler('get_device', self._get_device)

    async def _list_devices(self) -> list[dict]:
        known_ids = {d.get_data().get('id') for d in self._known_devices}
        return [
            {'id': r.id, 'name': r.name, 'data': {'id': r.id}}
            for r in sorted(self._devices, key=lambda x: x.name or '')
            if r.id not in known_ids
            and isinstance(r.txt, dict)
            and self._model_filter.search(r.txt.get('model', ''))
        ]

    async def _on_device_selected(self, devices: list) -> None:
        if devices:
            device_id = devices[-1].get('data', {}).get('id') if isinstance(devices[-1], dict) else devices[-1].id
            self._selected_device = next(
                (r for r in self._devices if r.id == device_id), None
            )

    async def _get_device(self, _: Any = None) -> dict:
        device = self._selected_device
        if device is None:
            return {}
        return {
            'name': device.name,
            'data': {'id': device.id},
        }

    async def _on_show_view(self, view: str) -> None:
        try:
            if view == 'authenticate':
                await self._on_show_view_authenticate()
            elif view == 'discover':
                await self._on_show_view_discover()
        except Exception as err:
            if self.on_error:
                self.on_error(err)

    async def _on_show_view_authenticate(self) -> None:
        if self._selected_device is None:
            await self._session.show_view('list_devices')
            if self.on_error:
                self.on_error('No device selected.')
            return

        device = self._selected_device
        if self.on_log:
            self.on_log(f'Connecting to {device.address}:{device.port} for transient pairing...')

        loop = asyncio.get_event_loop()
        config = PyATVConfig(
            address=ipaddress.IPv4Address(device.address),
            name=device.name or '',
        )
        config.add_service(
            ManualService(
                identifier=None,
                protocol=Protocol.AirPlay,
                port=device.port,
                properties=dict(device.txt),
            )
        )

        handler = await pyatv.pair(config, Protocol.AirPlay, loop)
        await handler.begin()
        await handler.finish()

        if self.on_log:
            self.on_log('Transient pairing successful.')

        await handler.close()
        await self._session.show_view('add_my_device')

    async def _on_show_view_discover(self) -> None:
        for _ in range(5):
            if self._devices:
                await self._session.show_view('list_devices')
                return
            await wait_for(1000)

        await self._session.show_view('list_devices')
