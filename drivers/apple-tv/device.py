"""Apple TV device — AirPlay + Companion Link via pyatv."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import pyatv
from pyatv.const import Protocol

from app.lib.airplay_logic import AirPlayLogic
from app.lib.discoverable_device import DiscoverableDevice

if TYPE_CHECKING:
    from pyatv.interface import AppleTV, BaseConfig

logger = logging.getLogger(__name__)

AIRPLAY_SERVICE = 'airplay'
COMPANION_SERVICE = 'companion-link'
RECONNECT_DELAY = 1.0  # seconds
# Scheduled Companion Link reconnect every 5 minutes
COMPANION_RECONNECT_INTERVAL = 5 * 60  # seconds

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
    'media_type',
    'volume_set',
    'button.restart',
]


class AppleTVDevice(DiscoverableDevice):
    """Represents a single Apple TV on the local network."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._atv: AppleTV | None = None
        self._airplay_logic: AirPlayLogic | None = None
        self._is_reconnecting = False
        self._companion_reconnect_task: asyncio.Task | None = None

    @property
    def services(self) -> list[str]:
        return [AIRPLAY_SERVICE, COMPANION_SERVICE]

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def on_init(self) -> None:
        await self.set_unavailable('Connecting...')

        self._airplay_logic = AirPlayLogic(self)

        for cap in list(self.get_capabilities()):
            if cap not in CAPABILITIES:
                try:
                    await self.remove_capability(cap)
                except Exception:
                    pass
        self._register_capabilities()

        await super().on_init()
        self.log('Initialized.')

    async def on_uninit(self) -> None:
        self._stop_companion_reconnect()
        if self._airplay_logic:
            self._airplay_logic.stop()
        await self._disconnect()
        self.log('Uninitialized.')

    # ------------------------------------------------------------------
    # Discovery callback → connect
    # ------------------------------------------------------------------

    async def _on_device_found(self, config: BaseConfig) -> None:
        """Called by DiscoverableDevice when the pyatv config is ready."""
        if self._atv is not None:
            return  # Already connected
        await self._connect()

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    async def _connect(self) -> None:
        """Connect to the Apple TV using stored discovery results.

        Raises on failure so callers (SDK discovery callback or _reconnect)
        can handle it appropriately.
        """
        config = self._discovery_results.get(AIRPLAY_SERVICE)
        if config is None:
            raise RuntimeError('Cannot find AirPlay service.')

        airplay_creds = self._get_credentials('credentials')
        if airplay_creds:
            service = config.get_service(Protocol.AirPlay)
            if service:
                service.credentials = airplay_creds

        companion_creds = self._get_credentials('companion_credentials')
        if companion_creds:
            service = config.get_service(Protocol.Companion)
            if service:
                service.credentials = companion_creds

        loop = asyncio.get_running_loop()
        self._atv = await pyatv.connect(config, loop)
        self._atv.listener = self
        self._airplay_logic.set_protocol(self._atv)

        self._start_companion_reconnect()

        self.log('Connected to Apple TV.')

    async def _disconnect(self) -> None:
        self._stop_companion_reconnect()
        if self._airplay_logic:
            self._airplay_logic.stop()
        if self._atv is not None:
            try:
                self._atv.close()
            except Exception:
                pass
            self._atv = None

    # ------------------------------------------------------------------
    # pyatv DeviceListener callbacks
    # ------------------------------------------------------------------

    def connection_lost(self, exception: Exception | None) -> None:
        self.log(f'Connection lost: {exception}')
        asyncio.create_task(self._on_disconnected(unexpected=True))

    def connection_closed(self) -> None:
        self.log('Connection closed.')
        asyncio.create_task(self._on_disconnected(unexpected=False))

    async def _on_disconnected(self, unexpected: bool) -> None:
        if not unexpected or self._is_reconnecting:
            return

        self._is_reconnecting = True
        try:
            self.log('Disconnected from Apple TV, reconnecting...')
            await self.set_unavailable('Disconnected from Apple TV, reconnecting...')
            await asyncio.sleep(RECONNECT_DELAY)
            await self._disconnect()
            await self._reconnect()
        except Exception as err:
            self.error(f'Reconnection failed: {err}')
            await self.set_unavailable(f'Cannot reconnect: {err}')
        finally:
            self._is_reconnecting = False

    # ------------------------------------------------------------------
    # Scheduled Companion reconnect (every 5 min)
    # ------------------------------------------------------------------

    def _start_companion_reconnect(self) -> None:
        if self._companion_reconnect_task and asyncio.current_task() is self._companion_reconnect_task:
            return

        self._stop_companion_reconnect()

        async def _reconnect_loop() -> None:
            while True:
                await asyncio.sleep(COMPANION_RECONNECT_INTERVAL)
                self.log('Scheduled Companion Link reconnect...')
                try:
                    await self._disconnect()
                    await self._reconnect()
                except Exception as err:
                    self.error(f'Scheduled reconnect failed: {err}')

        self._companion_reconnect_task = asyncio.create_task(_reconnect_loop())

    def _stop_companion_reconnect(self) -> None:
        task = self._companion_reconnect_task
        self._companion_reconnect_task = None
        if task and not task.done():
            if asyncio.current_task() is not task:
                task.cancel()

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
        self.register_capability_listener('remote_up', self._on_remote_up)
        self.register_capability_listener('remote_down', self._on_remote_down)
        self.register_capability_listener('remote_left', self._on_remote_left)
        self.register_capability_listener('remote_right', self._on_remote_right)
        self.register_capability_listener('remote_select', self._on_remote_select)
        self.register_capability_listener('remote_home', self._on_remote_home)
        self.register_capability_listener('remote_back', self._on_remote_back)
        self.register_capability_listener('remote_playpause', self._on_remote_playpause)
        self.register_capability_listener('button.restart', self._on_restart)

    async def _on_onoff(self, value: bool, *_) -> None:
        if self._atv is None:
            return
        if value:
            await self._atv.power.turn_on()
        else:
            await self._atv.power.turn_off()

    async def _on_speaker_next(self, *_) -> None:
        if self._atv is None:
            return
        await self._atv.remote_control.next()

    async def _on_speaker_prev(self, *_) -> None:
        if self._atv is None:
            return
        await self._atv.remote_control.previous()

    async def _on_speaker_playing(self, play: bool, *_) -> None:
        if self._atv is None:
            return
        # Use play_pause() for both — rc.play() can trigger Apple Music
        # instead of resuming the current media on newer Apple TVs
        await self._atv.remote_control.play_pause()

    async def _on_volume_up(self, *_) -> None:
        if self._atv is None:
            return
        try:
            await self._atv.audio.volume_up()
        except Exception as err:
            self.error(f'Volume up failed: {err}')

    async def _on_volume_down(self, *_) -> None:
        if self._atv is None:
            return
        try:
            await self._atv.audio.volume_down()
        except Exception as err:
            self.error(f'Volume down failed: {err}')

    async def _on_volume_mute(self, muted, *_) -> None:
        if self._atv is None:
            return
        try:
            if muted:
                await self._atv.audio.set_volume(0)
            self.log(f'Volume mute: {muted}')
        except Exception as err:
            self.error(f'Volume mute failed: {err}')

    async def _on_volume_set(self, volume: float, *_) -> None:
        if self._atv is None:
            return
        await self._atv.audio.set_volume(volume * 100)

    async def _on_remote_cmd(self, name, coro):
        if self._atv is None:
            return
        try:
            await coro
        except Exception as err:
            self.error(f'Remote {name} failed: {err}')

    async def _on_remote_up(self, *_): await self._on_remote_cmd('up', self._atv.remote_control.up())
    async def _on_remote_down(self, *_): await self._on_remote_cmd('down', self._atv.remote_control.down())
    async def _on_remote_left(self, *_): await self._on_remote_cmd('left', self._atv.remote_control.left())
    async def _on_remote_right(self, *_): await self._on_remote_cmd('right', self._atv.remote_control.right())
    async def _on_remote_select(self, *_): await self._on_remote_cmd('select', self._atv.remote_control.select())
    async def _on_remote_home(self, *_): await self._on_remote_cmd('home', self._atv.remote_control.home())
    async def _on_remote_back(self, *_): await self._on_remote_cmd('back', self._atv.remote_control.menu())
    async def _on_remote_playpause(self, *_): await self._on_remote_cmd('playpause', self._atv.remote_control.play_pause())

    async def _on_restart(self, *_) -> None:
        try:
            await self._disconnect()
            if self._airplay_logic:
                await self._airplay_logic.clear_now_playing()
            await self._reconnect()
        except Exception as err:
            self.error(err)


    # ------------------------------------------------------------------
    # Flow trigger hooks
    # ------------------------------------------------------------------

    async def trigger_now_playing_app_changed(self, bundle_id: str, display_name: str) -> None:
        app = self.homey.app
        if hasattr(app, 'apple_tv_flow') and app.apple_tv_flow:
            await app.apple_tv_flow.trigger_now_playing_app_changes(self, bundle_id, display_name)

    async def trigger_artwork_url_updated(self, image) -> None:
        app = self.homey.app
        if hasattr(app, 'apple_tv_flow') and app.apple_tv_flow:
            local_url = getattr(image, 'local_url', '') or ''
            cloud_url = getattr(image, 'cloud_url', '') or ''
            await app.apple_tv_flow.trigger_artwork_url_updated(self, local_url, cloud_url)

    async def trigger_companion_link_failed(self) -> None:
        app = self.homey.app
        if hasattr(app, 'apple_tv_flow') and app.apple_tv_flow:
            await app.apple_tv_flow.trigger_companion_link_failed(self)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_credentials(self, key: str = 'credentials') -> str | None:
        """Return stored credentials string from the device store, or None."""
        store = self.get_store()
        if not store:
            return None
        creds = store.get(key)
        if isinstance(creds, dict):
            self.error(f'Stored {key} in old format — please re-pair.')
            return None
        return creds if isinstance(creds, str) else None

homey_export = AppleTVDevice
