from __future__ import annotations

import asyncio
from typing import Any

import pyatv.interface as pyatv_interface

from ..base.discoverable_device import DiscoverableDevice
from ..connection.airplay import connect_with_credentials
from ..logic.airplay import AirPlayLogic
from ..utils.get_credentials_from_device import get_credentials_from_device

RECONNECT_DELAY_S = 1.0
SCHEDULED_RECONNECT_INTERVAL_S = 5 * 60

CAPABILITIES = [
    'speaker_album',
    'speaker_artist',
    'speaker_duration',
    'speaker_next',
    'speaker_playing',
    'speaker_position',
    'speaker_prev',
    'speaker_track',
    'artwork_url',
    'onoff',
    'power',
    'volume_down',
    'volume_mute',
    'volume_set',
    'volume_up',
    'remote_up',
    'remote_down',
    'remote_left',
    'remote_right',
    'remote_select',
    'remote_home',
    'remote_back',
    'remote_playpause',
    'now_playing_app',
    'button.restart',
]


class AppleTVDevice(DiscoverableDevice):
    """Homey device representing a paired Apple TV."""

    @property
    def atv(self) -> pyatv_interface.AppleTV | None:
        """The underlying pyatv AppleTV interface, or None if not connected."""
        return self._atv

    @property
    def airplay_logic(self) -> AirPlayLogic:
        return self._airplay_logic

    @property
    def services(self) -> list[str]:
        return ['airplay', 'companion-link']

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._atv: pyatv_interface.AppleTV | None = None
        self._airplay_logic: AirPlayLogic = None  # type: ignore[assignment]
        self._connected_once = False
        self._is_reconnecting = False
        self._last_volume_before_mute: float | None = None
        self._scheduled_reconnect_task: asyncio.Task | None = None

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
        self._stop_scheduled_reconnect()
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
        """Connect to the Apple TV using a pyatv config with all protocols."""
        credentials = get_credentials_from_device(self)
        if credentials is None:
            await self.set_unavailable(
                'Cannot find credentials, please re-pair the device.'
            )
            return

        try:
            self._atv = await connect_with_credentials(config, credentials)
            self._atv.listener = self
            self._airplay_logic.set_atv(self._atv)
            self._connected_once = True

            # Fetch and publish initial power state.
            try:
                initial_state = self._atv.power.power_state
                await self._airplay_logic._handle_power_state(initial_state)
            except Exception as err:
                self.error('Failed to fetch initial power state:', err)

            self._start_scheduled_reconnect()
            await self.set_available()
            self.log('Connected to Apple TV.')
        except Exception as err:
            self.error('Failed to connect to Apple TV:', err)
            await self.set_unavailable(f'Cannot connect to Apple TV: {err}')

    async def _disconnect(self) -> None:
        """Disconnect and clean up."""
        self._stop_scheduled_reconnect()
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
            self.log('Disconnected from Apple TV, reconnecting...')
            await self.set_unavailable('Disconnected from Apple TV, reconnecting...')
            await asyncio.sleep(RECONNECT_DELAY_S)
            await self._reconnect()
        finally:
            self._is_reconnecting = False

    # ------------------------------------------------------------------
    # Scheduled reconnect (handles Companion Link port changes)
    # ------------------------------------------------------------------

    def _start_scheduled_reconnect(self) -> None:
        self._stop_scheduled_reconnect()
        self._scheduled_reconnect_task = asyncio.create_task(self._scheduled_reconnect_loop())

    def _stop_scheduled_reconnect(self) -> None:
        if self._scheduled_reconnect_task is not None:
            self._scheduled_reconnect_task.cancel()
            self._scheduled_reconnect_task = None

    async def _scheduled_reconnect_loop(self) -> None:
        """Periodically reconnect to pick up port changes."""
        while True:
            await asyncio.sleep(SCHEDULED_RECONNECT_INTERVAL_S)

            if self._is_reconnecting:
                continue

            self._is_reconnecting = True
            try:
                self.log('Scheduled reconnection, re-scanning...')
                await self._reconnect()
            except Exception as err:
                self.error('Scheduled reconnect failed:', err)
            finally:
                self._is_reconnecting = False

    # ------------------------------------------------------------------
    # Capabilities
    # ------------------------------------------------------------------

    def _register_capabilities(self) -> None:
        self.register_capability_listener('onoff', self._on_onoff)
        self.register_capability_listener('speaker_next', self._on_speaker_next)
        self.register_capability_listener('speaker_prev', self._on_speaker_prev)
        self.register_capability_listener('speaker_playing', self._on_speaker_playing)
        self.register_capability_listener('volume_up', self._on_volume_up)
        self.register_capability_listener('volume_down', self._on_volume_down)
        self.register_capability_listener('volume_mute', self._on_volume_mute)
        self.register_capability_listener('volume_set', self._on_volume_set)
        self.register_capability_listener('button.restart', self._on_restart)

        self.register_capability_listener('remote_up', self._on_remote_up)
        self.register_capability_listener('remote_down', self._on_remote_down)
        self.register_capability_listener('remote_left', self._on_remote_left)
        self.register_capability_listener('remote_right', self._on_remote_right)
        self.register_capability_listener('remote_select', self._on_remote_select)
        self.register_capability_listener('remote_home', self._on_remote_home)
        self.register_capability_listener('remote_back', self._on_remote_back)
        self.register_capability_listener('remote_playpause', self._on_remote_playpause)

    # -- Power --

    async def _on_onoff(self, value: bool, **_: Any) -> None:
        if self._atv is None:
            return
        if value:
            await self._atv.power.turn_on()
        else:
            await self._atv.power.turn_off()
            await self._airplay_logic.clear_now_playing()

    # -- Speaker --

    async def _on_speaker_next(self, _: Any, **__: Any) -> None:
        if self._atv is not None:
            await self._atv.remote_control.next()

    async def _on_speaker_prev(self, _: Any, **__: Any) -> None:
        if self._atv is not None:
            await self._atv.remote_control.previous()

    async def _on_speaker_playing(self, play: bool, **_: Any) -> None:
        if self._atv is None:
            return
        if play:
            await self._atv.remote_control.play()
        else:
            await self._atv.remote_control.pause()

    # -- Volume --

    async def _on_volume_up(self, _: Any, **__: Any) -> None:
        if self._atv is not None:
            await self._atv.audio.volume_up()

    async def _on_volume_down(self, _: Any, **__: Any) -> None:
        if self._atv is not None:
            await self._atv.audio.volume_down()

    async def _on_volume_set(self, volume: float, **_: Any) -> None:
        if self._atv is not None:
            await self._atv.audio.set_volume(volume * 100)

    async def _on_volume_mute(self, _: Any, **__: Any) -> None:
        if self._atv is None:
            return

        audio = getattr(self._atv, 'audio', None)
        if audio is None:
            return

        try:
            current = float(getattr(audio, 'volume', None) or 0.0)

            if current > 0.0:
                self._last_volume_before_mute = current
                await audio.set_volume(0.0)
            else:
                restore = self._last_volume_before_mute
                if restore is None or restore <= 0.0:
                    restore = 20.0
                await audio.set_volume(float(restore))
        except Exception as err:
            self.error('Mute toggle via set_volume failed, falling back to volume_down steps:', err)
            try:
                for _ in range(10):
                    await audio.volume_down()
            except Exception:
                pass

    # -- Remote --

    async def _on_remote_up(self, value: bool, **_: Any) -> None:
        if value and self._atv is not None:
            await self._atv.remote_control.up()

    async def _on_remote_down(self, value: bool, **_: Any) -> None:
        if value and self._atv is not None:
            await self._atv.remote_control.down()

    async def _on_remote_left(self, value: bool, **_: Any) -> None:
        if value and self._atv is not None:
            await self._atv.remote_control.left()

    async def _on_remote_right(self, value: bool, **_: Any) -> None:
        if value and self._atv is not None:
            await self._atv.remote_control.right()

    async def _on_remote_select(self, value: bool, **_: Any) -> None:
        if value and self._atv is not None:
            await self._atv.remote_control.select()

    async def _on_remote_home(self, value: bool, **_: Any) -> None:
        if value and self._atv is not None:
            await self._atv.remote_control.home()

    async def _on_remote_back(self, value: bool, **_: Any) -> None:
        if value and self._atv is not None:
            await self._atv.remote_control.menu()

    async def _on_remote_playpause(self, value: bool, **_: Any) -> None:
        if value and self._atv is not None:
            await self._atv.remote_control.play_pause()

    # -- Maintenance --

    async def _on_restart(self, _: Any, **__: Any) -> None:
        try:
            await self._disconnect()
            await self._airplay_logic.clear_now_playing()
            config = await self.scan()
            if config is not None:
                await self._connect(config)
        except Exception as err:
            self.error(err)


homey_export = AppleTVDevice
