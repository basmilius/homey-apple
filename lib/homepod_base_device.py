"""Abstract base device for HomePod and HomePod Mini."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import pyatv
from pyatv.const import Protocol

from .airplay_logic import AirPlayLogic
from .discoverable_device import DiscoverableDevice

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
    'volume_down',
    'volume_set',
    'volume_up',
    'button.restart',
]


class HomePodBaseDevice(DiscoverableDevice):
    """Base class shared by HomePod and HomePod Mini devices."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._atv: AppleTV | None = None
        self._airplay_logic: AirPlayLogic | None = None
        self._is_reconnecting = False

    @property
    def services(self) -> list[str]:
        return [AIRPLAY_SERVICE]

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
        """Connect to the HomePod using stored discovery results.

        Raises on failure so callers can handle it appropriately.
        """
        config = self._discovery_results.get(AIRPLAY_SERVICE)
        if config is None:
            raise RuntimeError('Cannot find device on network.')

        credentials = self._get_credentials()
        if credentials is not None:
            service = config.get_service(Protocol.AirPlay)
            if service:
                service.credentials = credentials

        loop = asyncio.get_running_loop()
        self._atv = await pyatv.connect(config, loop)
        self._atv.listener = self
        self._airplay_logic.set_protocol(self._atv)

        self.log('Connected to HomePod.')

    async def _disconnect(self) -> None:
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
            self.log('Disconnected from HomePod, reconnecting...')
            await self.set_unavailable('Disconnected from HomePod, reconnecting...')
            await asyncio.sleep(RECONNECT_DELAY)
            await self._disconnect()
            await self._reconnect()
        except Exception as err:
            self.error(f'Reconnection failed: {err}')
            await self.set_unavailable(f'Cannot reconnect: {err}')
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
        if self._atv is None:
            return
        await self._atv.remote_control.next()

    async def _on_speaker_prev(self, *_) -> None:
        if self._atv is None:
            return
        await self._atv.remote_control.previous()

    async def _on_speaker_stop(self, *_) -> None:
        if self._atv is None:
            return
        await self._atv.remote_control.stop()

    async def _on_speaker_playing(self, play: bool, *_) -> None:
        if self._atv is None:
            return
        if play:
            await self._atv.remote_control.play()
        else:
            await self._atv.remote_control.pause()

    async def _on_volume_up(self, *_) -> None:
        if self._atv is None:
            return
        await self._atv.audio.volume_up()

    async def _on_volume_down(self, *_) -> None:
        if self._atv is None:
            return
        await self._atv.audio.volume_down()

    async def _on_volume_set(self, volume: float, *_) -> None:
        if self._atv is None:
            return
        # Homey uses 0.0–1.0; pyatv uses 0–100
        await self._atv.audio.set_volume(volume * 100)

    async def _on_restart(self, *_) -> None:
        try:
            await self._disconnect()
            if self._airplay_logic:
                await self._airplay_logic.clear_now_playing()
            await self._reconnect()
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
            await self._atv.audio.set_volume(volume)

        asyncio.create_task(self._stream_url(url))

    async def _stream_url(self, url: str) -> None:
        try:
            await self._atv.stream.play_url(url)
        except Exception as err:
            self.error(f'play_url failed: {err}')

    # ------------------------------------------------------------------
    # Flow trigger hooks
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
        """Return stored AirPlay credentials string, or None.

        Credentials must be a colon-separated hex string as produced by pyatv.
        If the stored value is a dict (left over from a previous app version),
        it cannot be used and the device will need to be re-paired.
        """
        store = self.get_store()
        if not store:
            return None
        creds = store.get('credentials')
        if isinstance(creds, dict):
            self.error(
                'Stored credentials are in an old format — please re-pair this device.'
            )
            return None
        return creds if isinstance(creds, str) else None
