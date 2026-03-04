from __future__ import annotations

import asyncio
import ipaddress
from typing import TYPE_CHECKING, Any

import pyatv
import pyatv.interface as pyatv_interface
from pyatv.conf import AppleTV as PyATVConfig, ManualService
from pyatv.const import Protocol

if TYPE_CHECKING:
    from ..apple_tv.device import AppleTVDevice
    from ..homepod_base.device import HomePodBaseDevice

AIRPLAY_SERVICE = 'airplay'
COMPANION_LINK_SERVICE = 'companion-link'

_RECONNECT_DELAY_MS = 1000
_MAX_CONNECT_ATTEMPTS = 3
_COMPANION_RECONNECT_INTERVAL_S = 5 * 60


class _AirPlayDeviceListener(pyatv_interface.DeviceListener):
    """Listens for AirPlay connection lifecycle events."""

    def __init__(self, connection: AirPlayConnection) -> None:
        self._connection = connection

    def connection_lost(self, exception: Exception) -> None:
        asyncio.ensure_future(self._connection._on_disconnected(unexpected=True))

    def connection_closed(self) -> None:
        asyncio.ensure_future(self._connection._on_disconnected(unexpected=False))


class _CompanionDeviceListener(pyatv_interface.DeviceListener):
    """Listens for Companion Link connection lifecycle events."""

    def __init__(self, connection: CompanionLinkConnection) -> None:
        self._connection = connection

    def connection_lost(self, exception: Exception) -> None:
        asyncio.ensure_future(self._connection._on_disconnected(unexpected=True))

    def connection_closed(self) -> None:
        asyncio.ensure_future(self._connection._on_disconnected(unexpected=False))


class _PowerListener(pyatv_interface.PowerListener):
    """Listens for power state changes from Companion Link."""

    def __init__(self, connection: CompanionLinkConnection) -> None:
        self._connection = connection

    def powerstate_update(
        self,
        old_state: pyatv.const.PowerState,
        new_state: pyatv.const.PowerState,
    ) -> None:
        asyncio.ensure_future(self._connection._on_power(new_state))


class AirPlayConnection:
    """Manages a pyatv AirPlay connection for an Apple TV or HomePod device."""

    @property
    def is_connected(self) -> bool:
        return self._atv is not None

    @property
    def atv(self) -> pyatv_interface.AppleTV | None:
        """The underlying pyatv AppleTV interface, or None if not connected."""
        return self._atv

    def __init__(self, device: AppleTVDevice | HomePodBaseDevice) -> None:
        self._device = device
        self._atv: pyatv_interface.AppleTV | None = None
        self._connected_callback: Any = None
        self._disconnected_callback: Any = None

    def set_callbacks(
        self,
        on_connected: Any,
        on_disconnected: Any,
    ) -> None:
        self._connected_callback = on_connected
        self._disconnected_callback = on_disconnected

    async def connect(
        self,
        address: str,
        port: int,
        txt_properties: dict[str, str],
        credentials: str | None,
    ) -> None:
        """Create a pyatv AppleTV config and connect via AirPlay."""
        loop = asyncio.get_event_loop()
        config = _build_config(
            address=address,
            name=self._device.get_name(),
            protocol=Protocol.AirPlay,
            port=port,
            txt_properties=txt_properties,
            credentials=credentials,
        )

        try:
            self._atv = await pyatv.connect(config, loop)
            listener = _AirPlayDeviceListener(self)
            self._atv.listener = listener
        except Exception as err:
            self._device.error('Failed to connect via AirPlay:', err)
            await self._device.set_unavailable(
                f'Failed to connect via AirPlay. {err}'
            )
            return

        if self._connected_callback:
            await self._connected_callback()

    async def disconnect(self) -> None:
        """Disconnect and clean up the pyatv connection."""
        if self._atv is not None:
            self._atv.close()
            self._atv = None

    async def _on_disconnected(self, unexpected: bool) -> None:
        self._atv = None
        if self._disconnected_callback:
            await self._disconnected_callback(unexpected)


class CompanionLinkConnection:
    """
    Manages a pyatv Companion Link connection for an Apple TV.

    The Companion protocol provides app launching, account switching and
    attention-state (power) events that are not available via AirPlay alone.
    """

    @property
    def is_connected(self) -> bool:
        return self._atv is not None

    @property
    def atv(self) -> pyatv_interface.AppleTV | None:
        return self._atv

    def __init__(self, device: AppleTVDevice) -> None:
        self._device = device
        self._atv: pyatv_interface.AppleTV | None = None
        self._connect_attempts = 0
        self._reconnect_task: asyncio.Task | None = None
        self._connected_callback: Any = None
        self._disconnected_callback: Any = None
        self._failed_callback: Any = None

    def set_callbacks(
        self,
        on_connected: Any,
        on_disconnected: Any,
        on_failed: Any,
    ) -> None:
        self._connected_callback = on_connected
        self._disconnected_callback = on_disconnected
        self._failed_callback = on_failed

    async def connect(
        self,
        address: str,
        port: int,
        txt_properties: dict[str, str],
        credentials: str | None,
    ) -> None:
        """Create a pyatv AppleTV config and connect via Companion Link."""
        loop = asyncio.get_event_loop()
        config = _build_config(
            address=address,
            name=self._device.get_name(),
            protocol=Protocol.Companion,
            port=port,
            txt_properties=txt_properties,
            credentials=credentials,
        )

        try:
            self._atv = await pyatv.connect(config, loop)
            listener = _CompanionDeviceListener(self)
            self._atv.listener = listener

            power_listener = _PowerListener(self)
            self._atv.power.listener = power_listener
        except Exception as err:
            self._device.error('Failed to connect via Companion Link:', err)
            await self._device.set_unavailable(
                f'Failed to connect via Companion Link. {err}'
            )
            return

        self._connect_attempts = 0
        self._start_reconnect_interval()

        if self._connected_callback:
            await self._connected_callback()

    async def disconnect(self) -> None:
        """Disconnect and stop the periodic reconnect interval."""
        self._stop_reconnect_interval()
        if self._atv is not None:
            self._atv.close()
            self._atv = None

    def _start_reconnect_interval(self) -> None:
        self._stop_reconnect_interval()
        self._reconnect_task = asyncio.ensure_future(self._reconnect_loop())

    def _stop_reconnect_interval(self) -> None:
        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            self._reconnect_task = None

    async def _reconnect_loop(self) -> None:
        """Periodically reconnect Companion Link to handle port changes."""
        while True:
            await asyncio.sleep(_COMPANION_RECONNECT_INTERVAL_S)

            self._device.log(
                'Scheduled reconnection interval reached, restarting Companion Link connection...'
            )
            try:
                await self.disconnect()
                await self._device.refresh_companion_link_discovery()
            except Exception as err:
                self._device.error('Failed to restart Companion Link connection:', err)

    async def _on_disconnected(self, unexpected: bool) -> None:
        self._atv = None
        self._connect_attempts += 1

        if self._connect_attempts >= _MAX_CONNECT_ATTEMPTS:
            if self._failed_callback:
                await self._failed_callback()
        else:
            if self._disconnected_callback:
                await self._disconnected_callback(unexpected)

    async def _on_power(self, state: pyatv.const.PowerState) -> None:
        """Handle power state change events from Companion Link."""
        self._device.log('Power state changed:', state)

        is_on = state == pyatv.const.PowerState.On

        try:
            await self._device.set_capability_value('onoff', is_on)
            await self._device.set_capability_value(
                'power',
                self._device.homey.i18n.translate(
                    'capability.power.on' if is_on else 'capability.power.off'
                ),
            )
        except Exception as err:
            self._device.error('Failed to set power state:', err)

        if not is_on:
            await self._device.airplay_logic.clear_now_playing()


def _build_config(
    address: str,
    name: str,
    protocol: Protocol,
    port: int,
    txt_properties: dict[str, str],
    credentials: str | None,
) -> PyATVConfig:
    """Build a pyatv AppleTV configuration with a single service."""
    config = PyATVConfig(
        address=ipaddress.IPv4Address(address),
        name=name,
    )
    service = ManualService(
        identifier=None,
        protocol=protocol,
        port=port,
        properties=txt_properties,
        credentials=credentials,
    )
    config.add_service(service)
    return config
