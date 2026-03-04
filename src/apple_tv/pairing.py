from __future__ import annotations

import asyncio
import ipaddress
from typing import Any

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

        # Listen for newly discovered devices during the pairing flow
        strategy.on('result', lambda r: self._devices.append(r))

    async def start(self) -> None:
        self._session.set_handler('showView', self._on_show_view)

        self._session.set_handler(
            'list_devices',
            lambda _=None: self._list_devices(),
        )

        self._session.set_handler(
            'list_devices_selection',
            self._on_device_selected,
        )

        self._session.set_handler('pincode', self._on_pincode)

        self._session.set_handler('get_device', self._get_device)

    async def _list_devices(self) -> list[dict]:
        known_ids = {d.get_data().get('id') for d in self._known_devices}
        return [
            {'id': r.id, 'name': r.name, 'data': {'id': r.id}}
            for r in sorted(self._devices, key=lambda x: x.name or '')
            if r.id not in known_ids
            and isinstance(r.txt, dict)
            and str(r.txt.get('model', '')).startswith('AppleTV')
        ]

    async def _on_device_selected(self, devices: list) -> None:
        if devices:
            device_id = devices[-1].get('data', {}).get('id') if isinstance(devices[-1], dict) else devices[-1].id
            self._selected_device = next(
                (r for r in self._devices if r.id == device_id), None
            )

    async def _on_pincode(self, code: Any) -> None:
        if self._pairing_handler is None:
            return

        pin = ''.join(str(b) for b in code) if isinstance(code, (list, bytes)) else str(code)

        if self.on_log:
            self.on_log(f'Pairing to {getattr(self._selected_device, "name", "?")} with PIN {pin}')

        self._pairing_handler.pin(int(pin))

        try:
            await self._pairing_handler.finish()
        except Exception as err:
            if self.on_error:
                self.on_error(err)
            return

        credentials = self._pairing_handler.service.credentials
        self._selected_device._pyatv_credentials = credentials

        await self._session.show_view('add_my_device')
        await self._pairing_handler.close()

    async def _get_device(self, _: Any = None) -> dict:
        device = self._selected_device
        if device is None:
            return {}

        credentials = getattr(device, '_pyatv_credentials', None)
        return {
            'name': device.name,
            'data': {'id': device.id},
            'store': {
                'id': device.id,
                'airplay_credentials': credentials,
            },
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
            self.on_log(f'Connecting to {device.address}:{device.port} for pairing...')

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

        self._pairing_handler = await pyatv.pair(config, Protocol.AirPlay, loop)
        await self._pairing_handler.begin()

    async def _on_show_view_discover(self) -> None:
        for _ in range(5):
            if self._devices:
                await self._session.show_view('list_devices')
                return
            await wait_for(1000)

        await self._session.show_view('list_devices')
