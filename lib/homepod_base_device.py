"""Abstract base device for HomePod and HomePod Mini."""

from __future__ import annotations

import asyncio
import logging
from abc import abstractmethod
from typing import TYPE_CHECKING

import pyatv
from pyatv.const import Protocol

from lib.airplay_logic import AirPlayLogic
from lib.discoverable_device import DiscoverableDevice

if TYPE_CHECKING:
    from pyatv.interface import AppleTV, BaseConfig

logger = logging.getLogger(__name__)

AIRPLAY_SERVICE = 'airplay'
RECONNECT_DELAY = 1.0  # seconds

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
    'media_type',
    'volume_down',
    'volume_set',
    'volume_up',
    'button.restart',
]


class HomePodBaseDevice(DiscoverableDevice):
    """Base class shared by HomePod and HomePod Mini devices."""

    def __init__(self) -> None:
        super().__init__()
        self._atv: AppleTV | None = None
        self._airplay_logic: AirPlayLogic | None = None
        self._connected_once = False
        self._is_reconnecting = False

    @property
    def services(self) -> list[str]:
        return [AIRPLAY_SERVICE]

    async def on_init(self) -> None:
        await self.set_unavailable('Connecting...')

        self._airplay_logic = AirPlayLogic(self)

        await self.remove_old_capabilities(CAPABILITIES)
        self._register_capabilities()

        await super().on_init()
        self.log('Initialized.')

    async def on_uninit(self) -> None:
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

        self._connected_once = True
        await self._connect()

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    async def _connect(self) -> None:
        try:
            config = self._discovery_results.get(AIRPLAY_SERVICE)
            if config is None:
                await self.set_unavailable('Cannot find device on network.')
                return

            credentials = self._get_credentials()
            if credentials is not None:
                service = config.get_service(Protocol.AirPlay)
                if service:
                    service.credentials = credentials

            loop = asyncio.get_event_loop()
            self._atv = await pyatv.connect(config, loop)
            self._atv.listener = self
            self._airplay_logic.set_protocol(self._atv)

            await self.set_available()
            self.log('Connected to HomePod.')
        except Exception as err:
            self.error(f'Failed to connect to HomePod: {err}')
            await self.set_unavailable(f'Cannot connect to HomePod: {err}')

    async def _disconnect(self) -> None:
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
            self.log('Disconnected from HomePod, reconnecting...')
            await self.set_unavailable('Disconnected from HomePod, reconnecting...')
            await asyncio.sleep(RECONNECT_DELAY)

            await self.find_service(AIRPLAY_SERVICE)
            await self._connect()
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

    async def _on_speaker_next(self, *_) -> None:
        await self._atv.remote_control.next()

    async def _on_speaker_prev(self, *_) -> None:
        await self._atv.remote_control.previous()

    async def _on_speaker_stop(self, *_) -> None:
        await self._atv.remote_control.stop()

    async def _on_speaker_playing(self, play: bool, *_) -> None:
        if play:
            await self._atv.remote_control.play()
        else:
            await self._atv.remote_control.pause()

    async def _on_volume_up(self, *_) -> None:
        await self._atv.audio.volume_up()

    async def _on_volume_down(self, *_) -> None:
        await self._atv.audio.volume_down()

    async def _on_volume_set(self, volume: float, *_) -> None:
        # Homey uses 0.0–1.0; pyatv uses 0–100
        await self._atv.audio.set_volume(volume * 100)

    async def _on_restart(self, *_) -> None:
        try:
            await self._disconnect()
            if self._airplay_logic:
                await self._airplay_logic.clear_now_playing()
            await self._connect()
        except Exception as err:
            self.error(err)

    # ------------------------------------------------------------------
    # RAOP audio streaming
    # ------------------------------------------------------------------

    async def play_url(self, url: str, volume: float | None = None) -> None:
        """Stream audio from a URL to this HomePod via AirPlay."""
        if self._atv is None:
            raise RuntimeError('Not connected.')

        if volume is not None:
            await self._atv.audio.set_volume(volume * 100)

        # Stream in the background so the flow action returns immediately
        asyncio.ensure_future(self._stream_url(url))

    async def _stream_url(self, url: str) -> None:
        try:
            await self._atv.stream.play_url(url)
        except Exception as err:
            self.error(f'play_url failed: {err}')

    # ------------------------------------------------------------------
    # Flow trigger hooks (overridden by AppleTVDevice)
    # ------------------------------------------------------------------

    async def trigger_now_playing_app_changed(self, bundle_id: str, display_name: str) -> None:
        pass

    async def trigger_artwork_url_updated(self, image) -> None:
        app = self.homey.app
        if hasattr(app, 'homepod_flow') and app.homepod_flow:
            local_url = getattr(image, 'local_url', '') or ''
            cloud_url = getattr(image, 'cloud_url', '') or ''
            await app.homepod_flow.trigger_artwork_url_updated(self, local_url, cloud_url)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_credentials(self) -> str | None:
        """Return stored AirPlay credentials string, or None."""
        store = self.get_store()
        return store.get('credentials') if store else None
