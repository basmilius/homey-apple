"""Apple TV pairing — AirPlay + Companion Link PIN-based pairing via pyatv."""

from __future__ import annotations

import asyncio
import re
from typing import TYPE_CHECKING

import pyatv
from pyatv.const import Protocol

if TYPE_CHECKING:
    import homey

DISCOVER_RETRIES = 5
DISCOVER_RETRY_INTERVAL = 1.0  # seconds
APPLE_TV_MODEL_PATTERN = re.compile(r'AppleTV\d+,\d+')


class AppleTVPairing:
    def __init__(
        self,
        session: homey.Driver.PairSession,
        known_devices: list,
        homey: homey.Homey,
        repair_device_id: str | None = None,
    ) -> None:
        self._session = session
        self._known_devices = known_devices
        self._homey = homey
        self._repair_device_id = repair_device_id
        self._devices: list = []
        self._selected_device = None
        self._pairing = None
        # Two-step pairing: AirPlay first, then Companion
        self._pairing_step = 'airplay'
        self._airplay_credentials: str | None = None
        self._companion_credentials: str | None = None

    async def start(self) -> None:
        self._session.set_handler('showView', self._on_show_view)
        self._session.set_handler('list_devices', self._on_list_devices)
        self._session.set_handler('list_devices_selection', self._on_list_devices_selection)
        self._session.set_handler('pincode', self._on_pincode)
        self._session.set_handler('get_device', self._on_get_device)

        await self._load_devices()

    # ------------------------------------------------------------------
    # Session handlers
    # ------------------------------------------------------------------

    async def _on_show_view(self, view: str) -> None:
        try:
            if view == 'discover':
                await self._on_show_view_discover()
            elif view == 'authenticate':
                await self._on_show_view_authenticate()
        except Exception:
            pass

    async def _on_list_devices(self, data=None) -> list:
        known_ids = {d.get_data().get('id') for d in self._known_devices}

        result = []
        for d in self._devices:
            airplay_props = d.properties.get('_airplay._tcp.local', {})
            model = airplay_props.get('model', '')
            if not APPLE_TV_MODEL_PATTERN.search(model):
                continue

            if self._repair_device_id:
                if d.identifier != self._repair_device_id:
                    continue
            else:
                if d.identifier in known_ids:
                    continue

            result.append({
                'name': d.name,
                'data': {'id': d.identifier},
            })

        return sorted(result, key=lambda d: d['name'])

    async def _on_list_devices_selection(self, devices: list) -> None:
        if not devices:
            return
        selected = devices[-1]
        selected_id = selected.get('data', {}).get('id') if isinstance(selected, dict) else None
        for d in self._devices:
            if d.identifier == selected_id:
                self._selected_device = d
                break

    async def _on_pincode(self, code) -> None:
        """Receive the PIN and complete the current pairing step."""
        if self._pairing is None:
            return

        if isinstance(code, (list, tuple)):
            pin = ''.join(str(c) for c in code)
        else:
            pin = str(code)

        try:
            self._pairing.pin(pin)
            await self._pairing.finish()

            if not self._pairing.has_paired:
                await self._session.show_view('authenticate')
                return

            credentials = self._pairing.service.credentials

            if self._pairing_step == 'airplay':
                self._airplay_credentials = credentials
                # Now pair Companion Link for remote control
                self._pairing_step = 'companion'
                await self._close_pairing()
                # Show the PIN screen again for Companion pairing
                await self._session.show_view('authenticate')

            elif self._pairing_step == 'companion':
                self._companion_credentials = credentials
                await self._close_pairing()
                await self._session.show_view('add_my_device')

        except Exception:
            await self._close_pairing()
            # Retry this step
            await self._session.show_view('authenticate')

    async def _on_get_device(self, data=None) -> dict | None:
        if not self._selected_device:
            return None

        return {
            'name': self._selected_device.name,
            'data': {
                'id': self._selected_device.identifier,
            },
            'store': {
                'id': self._selected_device.identifier,
                'credentials': self._airplay_credentials,
                'companion_credentials': self._companion_credentials,
            },
        }

    # ------------------------------------------------------------------
    # View handlers
    # ------------------------------------------------------------------

    async def _on_show_view_discover(self) -> None:
        for attempt in range(DISCOVER_RETRIES):
            if self._devices:
                break
            await asyncio.sleep(DISCOVER_RETRY_INTERVAL)
            await self._load_devices()

        await self._session.show_view('list_devices')

    async def _on_show_view_authenticate(self) -> None:
        if not self._selected_device:
            await self._session.show_view('list_devices')
            return

        protocol = Protocol.AirPlay if self._pairing_step == 'airplay' else Protocol.Companion

        loop = asyncio.get_running_loop()
        self._pairing = await pyatv.pair(self._selected_device, protocol, loop)
        await self._pairing.begin()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _close_pairing(self) -> None:
        if self._pairing is not None:
            try:
                await self._pairing.close()
            except Exception:
                pass
            self._pairing = None

    async def _load_devices(self) -> None:
        loop = asyncio.get_running_loop()
        hosts = self._get_discovery_hosts()
        try:
            if hosts:
                results = await pyatv.scan(loop, timeout=5, hosts=hosts)
            else:
                results = await pyatv.scan(loop, timeout=5)
            self._devices = results
        except Exception:
            pass

    def _get_discovery_hosts(self) -> list[str]:
        """Return known host IPs from Homey's discovery."""
        seen: set[str] = set()
        hosts: list[str] = []
        for strategy_id in ('airplay', 'companion-link'):
            try:
                strategy = self._homey.discovery.get_strategy(strategy_id)
                for result in strategy.get_discovery_results().values():
                    ip = str(result.address)
                    if ip not in seen:
                        seen.add(ip)
                        hosts.append(ip)
            except Exception:
                pass
        return hosts
