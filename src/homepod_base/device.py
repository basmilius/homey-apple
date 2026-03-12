from __future__ import annotations

import asyncio
from typing import Any

import pyatv.interface as pyatv_interface

from ..base.discoverable_device import DiscoverableDevice
from ..connection.airplay import connect_with_credentials
from ..logic.airplay import AirPlayLogic
from ..utils.get_credentials_from_device import get_credentials_from_device

RECONNECT_DELAY_S = 1.0

CAPABILITIES = [
    'speaker_album',
    'speaker_artist',
    'speaker_duration',
    'speaker_next',
    'speaker_playing',
    'speaker_position',
    'speaker_prev',
    'speaker_stop',
    'speaker_track',
    'artwork_url',
    'volume_down',
    'volume_set',
    'volume_up',
    'button.restart',
]


class HomePodBaseDevice(DiscoverableDevice):
    """Homey device base class for HomePod and HomePod Mini."""

    @property
    def atv(self) -> pyatv_interface.AppleTV | None:
        """The underlying pyatv AppleTV interface, or None if not connected."""
        return self._atv

    @property
    def airplay_logic(self) -> AirPlayLogic:
        return self._airplay_logic

    @property
    def services(self) -> list[str]:
        return ['airplay']

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._atv: pyatv_interface.AppleTV | None = None
        self._airplay_logic: AirPlayLogic = None  # type: ignore[assignment]
        self._connected_once = False
        self._is_reconnecting = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def on_init(self) -> None:
        await self.set_unavailable('Connecting...')

        from ..app import AppleApp
        app: AppleApp = AppleApp._instance  # type: ignore[assignment]

        self._airplay_logic = AirPlayLogic(self, app)
        await self._airplay_logic.initialize()

        await self.remove_old_capabilities(CAPABILITIES)
        self._register_capabilities()

        # Start initial connection via pyatv.scan().
        asyncio.create_task(self._initial_connect())

        self.log('Initialized.')

    async def on_uninit(self) -> None:
        await self._airplay_logic.uninitialize()
        await self._disconnect()
        self.log('Uninitialized.')

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    async def _initial_connect(self) -> None:
        """Scan for the device and connect."""
        config = await self.scan()
        if config is None:
            await self.set_unavailable(
                'Cannot find device on network. You might need to re-pair.'
            )
            return

        await self._connect(config)

    async def _connect(self, config: pyatv_interface.BaseConfig) -> None:
        """Connect to the HomePod using a pyatv config."""
        # HomePod uses transient pairing (no persistent credentials required).
        credentials = get_credentials_from_device(self)

        try:
            self._atv = await connect_with_credentials(config, credentials)
            self._atv.listener = self
            self._airplay_logic.set_atv(self._atv)
            self._connected_once = True

            await self.set_available()
            self.log('Connected to HomePod.')
        except Exception as err:
            self.error('Failed to connect to HomePod:', err)
            await self.set_unavailable(f'Cannot connect to HomePod: {err}')

    async def _disconnect(self) -> None:
        """Disconnect and clean up."""
        self._airplay_logic.stop()
        if self._atv is not None:
            self._atv.close()
            self._atv = None

    async def _reconnect(self) -> None:
        """Disconnect, re-scan, and reconnect."""
        await self._disconnect()

        config = await self.scan()
        if config is None:
            await self.set_unavailable(
                'Cannot find device on network after reconnect attempt.'
            )
            return

        await self._connect(config)

    # ------------------------------------------------------------------
    # pyatv DeviceListener (connection_lost / connection_closed)
    # ------------------------------------------------------------------

    def connection_lost(self, exception: Exception) -> None:
        self.log('Connection lost:', exception)
        asyncio.create_task(self._on_disconnected())

    def connection_closed(self) -> None:
        self.log('Connection closed.')

    async def _on_disconnected(self) -> None:
        """Handle unexpected disconnection with reconnect guard."""
        if self._is_reconnecting:
            return

        self._is_reconnecting = True
        try:
            self.log('Disconnected from HomePod, reconnecting...')
            await self.set_unavailable('Disconnected from HomePod, reconnecting...')
            await asyncio.sleep(RECONNECT_DELAY_S)
            await self._reconnect()
        finally:
            self._is_reconnecting = False

    # ------------------------------------------------------------------
    # Capabilities
    # ------------------------------------------------------------------

    def _register_capabilities(self) -> None:
        self.register_capability_listener('speaker_next', self._on_speaker_next)
        self.register_capability_listener('speaker_prev', self._on_speaker_prev)
        self.register_capability_listener('speaker_stop', self._on_speaker_stop)
        self.register_capability_listener('speaker_playing', self._on_speaker_playing)
        self.register_capability_listener('volume_up', self._on_volume_up)
        self.register_capability_listener('volume_down', self._on_volume_down)
        self.register_capability_listener('volume_set', self._on_volume_set)
        self.register_capability_listener('button.restart', self._on_restart)

    async def _on_speaker_next(self, _: Any, **__: Any) -> None:
        if self._atv is not None:
            await self._atv.remote_control.next()

    async def _on_speaker_prev(self, _: Any, **__: Any) -> None:
        if self._atv is not None:
            await self._atv.remote_control.previous()

    async def _on_speaker_stop(self, _: Any, **__: Any) -> None:
        if self._atv is not None:
            await self._atv.remote_control.stop()

    async def _on_speaker_playing(self, play: bool, **_: Any) -> None:
        if self._atv is None:
            return
        if play:
            await self._atv.remote_control.play()
        else:
            await self._atv.remote_control.pause()

    async def _on_volume_up(self, _: Any, **__: Any) -> None:
        if self._atv is not None:
            await self._atv.audio.volume_up()

    async def _on_volume_down(self, _: Any, **__: Any) -> None:
        if self._atv is not None:
            await self._atv.audio.volume_down()

    async def _on_volume_set(self, volume: float, **_: Any) -> None:
        if self._atv is not None:
            # Homey uses 0.0–1.0; pyatv uses 0–100.
            await self._atv.audio.set_volume(volume * 100)

    async def _on_restart(self, _: Any, **__: Any) -> None:
        try:
            await self._disconnect()
            await self._airplay_logic.clear_now_playing()
            config = await self.scan()
            if config is not None:
                await self._connect(config)
        except Exception as err:
            self.error(err)

    # ------------------------------------------------------------------
    # URL streaming
    # ------------------------------------------------------------------

    async def play_url(self, url: str, volume: float | None = None) -> None:
        """Stream a URL to the HomePod via AirPlay."""
        if self._atv is None:
            raise RuntimeError('Not connected.')

        if volume is not None:
            await self._atv.audio.set_volume(volume)

        # Stream in the background so the flow action returns immediately.
        asyncio.create_task(self._stream_url(url))

    async def _stream_url(self, url: str) -> None:
        try:
            await self._atv.stream.play_url(url)
        except Exception as err:
            self.error(f'play_url failed: {err}')


homey_export = HomePodBaseDevice
