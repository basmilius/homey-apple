"""Apple TV device — AirPlay + Companion Link via pyatv."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import pyatv
from pyatv.const import Protocol

from lib.airplay_logic import AirPlayLogic
from lib.discoverable_device import DiscoverableDevice

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
    'button.repair',
]


class AppleTVDevice(DiscoverableDevice):
    """Represents a single Apple TV on the local network."""

    def __init__(self) -> None:
        super().__init__()
        self._atv: AppleTV | None = None
        self._airplay_logic: AirPlayLogic | None = None
        self._connected_once = False
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

        await self.remove_old_capabilities(CAPABILITIES)
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
    # Discovery
    # ------------------------------------------------------------------

    async def on_service_found(self, service: str, config: BaseConfig) -> None:
        await super().on_service_found(service, config)

        if self._connected_once:
            return

        # Wait until both services are resolved before connecting
        if AIRPLAY_SERVICE not in self._discovery_results:
            return
        if COMPANION_SERVICE not in self._discovery_results:
            return

        self._connected_once = True
        await self._connect()

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    async def _connect(self) -> None:
        try:
            config = self._discovery_results.get(AIRPLAY_SERVICE)
            if config is None:
                await self.set_unavailable('Cannot find AirPlay service.')
                return

            credentials = self._get_credentials()
            if credentials:
                for protocol in (Protocol.AirPlay, Protocol.Companion, Protocol.MRP):
                    service = config.get_service(protocol)
                    if service and credentials.get(protocol.name.lower()):
                        service.credentials = credentials[protocol.name.lower()]

            loop = asyncio.get_event_loop()
            self._atv = await pyatv.connect(config, loop)
            self._atv.listener = self
            self._airplay_logic.set_protocol(self._atv)

            self._start_companion_reconnect()

            await self.set_available()
            self.log('Connected to Apple TV.')
        except Exception as err:
            self.error(f'Failed to connect to Apple TV: {err}')
            await self.set_unavailable(f'Cannot connect to Apple TV: {err}')

    async def _disconnect(self) -> None:
        self._stop_companion_reconnect()
        if self._airplay_logic:
            self._airplay_logic.stop()
        if self._atv is not None:
            try:
                await self._atv.close()
            except Exception:
                pass
            self._atv = None

    # ------------------------------------------------------------------
    # pyatv DeviceListener callbacks
    # ------------------------------------------------------------------

    def connection_lost(self, exception: Exception | None) -> None:
        self.log(f'Connection lost: {exception}')
        asyncio.ensure_future(self._on_disconnected(unexpected=True))

    def connection_closed(self) -> None:
        self.log('Connection closed.')
        asyncio.ensure_future(self._on_disconnected(unexpected=False))

    async def _on_disconnected(self, unexpected: bool) -> None:
        if not unexpected or self._is_reconnecting:
            return

        self._is_reconnecting = True
        try:
            self.log('Disconnected from Apple TV, reconnecting...')
            await self.set_unavailable('Disconnected from Apple TV, reconnecting...')
            await asyncio.sleep(RECONNECT_DELAY)

            await self.find_service(AIRPLAY_SERVICE)
            await self._connect()
        finally:
            self._is_reconnecting = False

    # ------------------------------------------------------------------
    # Scheduled Companion reconnect (every 5 min)
    # ------------------------------------------------------------------

    def _start_companion_reconnect(self) -> None:
        self._stop_companion_reconnect()

        async def _reconnect_loop() -> None:
            while True:
                await asyncio.sleep(COMPANION_RECONNECT_INTERVAL)
                self.log('Scheduled Companion Link reconnect...')
                try:
                    await self._disconnect()
                    await self.find_service(AIRPLAY_SERVICE)
                    await self._connect()
                except Exception as err:
                    self.error(f'Scheduled reconnect failed: {err}')

        self._companion_reconnect_task = asyncio.ensure_future(_reconnect_loop())

    def _stop_companion_reconnect(self) -> None:
        if self._companion_reconnect_task and not self._companion_reconnect_task.done():
            self._companion_reconnect_task.cancel()
        self._companion_reconnect_task = None

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
        self.register_multiple_capability_listener(
            [k for k in CAPABILITIES if k.startswith('remote_')],
            self._on_remote,
            delay=0,
        )
        self.register_capability_listener('button.restart', self._on_restart)
        self.register_capability_listener('button.repair', self._on_repair)

    async def _on_onoff(self, value: bool, *_) -> None:
        if value:
            await self._atv.power.turn_on()
        else:
            await self._atv.power.turn_off()

    async def _on_speaker_next(self, *_) -> None:
        await self._atv.remote_control.next()

    async def _on_speaker_prev(self, *_) -> None:
        await self._atv.remote_control.previous()

    async def _on_speaker_playing(self, play: bool, *_) -> None:
        if play:
            await self._atv.remote_control.play()
        else:
            await self._atv.remote_control.pause()

    async def _on_volume_up(self, *_) -> None:
        await self._atv.audio.volume_up()

    async def _on_volume_down(self, *_) -> None:
        await self._atv.audio.volume_down()

    async def _on_volume_mute(self, *_) -> None:
        # pyatv does not have a dedicated mute; toggle volume to 0
        await self._atv.audio.set_volume(0)

    async def _on_volume_set(self, volume: float, *_) -> None:
        await self._atv.audio.set_volume(volume * 100)

    async def _on_remote(self, values: dict, *_) -> None:
        rc = self._atv.remote_control
        if values.get('remote_up'):
            await rc.up()
        if values.get('remote_down'):
            await rc.down()
        if values.get('remote_left'):
            await rc.left()
        if values.get('remote_right'):
            await rc.right()
        if values.get('remote_select'):
            await rc.select()
        if values.get('remote_home'):
            await rc.home()
        if values.get('remote_back'):
            await rc.menu()
        if values.get('remote_playpause'):
            await rc.play_pause()

    async def _on_restart(self, *_) -> None:
        try:
            await self._disconnect()
            if self._airplay_logic:
                await self._airplay_logic.clear_now_playing()
            await self._connect()
        except Exception as err:
            self.error(err)

    async def _on_repair(self, *_) -> None:
        await self.set_unavailable(
            'Please re-pair this device: go to Devices → Apple TV → Settings → Re-pair.'
        )

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

    def _get_credentials(self) -> dict | None:
        """Return stored credentials dict keyed by protocol name."""
        store = self.get_store()
        return store.get('credentials') if store else None
