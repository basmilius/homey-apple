from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pyatv
from pyatv.const import Protocol

from ..base.discoverable_device import AIRPLAY_SERVICE, DiscoverableDevice
from ..connection.airplay import AirPlayConnection
from ..logic.airplay import AirPlayLogic
from ..utils.get_credentials_from_device import get_credentials_from_device
from ..utils.wait_for import wait_for

if TYPE_CHECKING:
    from homey.discovery_result_mdns_sd import DiscoveryResultMDNSSD

    from .driver import HomePodBaseDriver

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
    def airplay(self) -> AirPlayConnection:
        return self._airplay

    @property
    def airplay_logic(self) -> AirPlayLogic:
        return self._airplay_logic

    @property
    def discovery_result(self) -> DiscoveryResultMDNSSD | None:
        return self.discovery_results.get(AIRPLAY_SERVICE)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._airplay: AirPlayConnection = None  # type: ignore[assignment]
        self._airplay_logic: AirPlayLogic = None  # type: ignore[assignment]
        self._connected_once = False

    async def on_init(self) -> None:
        await self.set_unavailable('Connecting...')

        from ..app import AppleApp
        app: AppleApp = AppleApp._instance  # type: ignore[assignment]

        self._airplay_logic = AirPlayLogic(self, app)
        await self._airplay_logic.initialize()

        self._airplay = AirPlayConnection(self)
        self._airplay.set_callbacks(
            on_connected=self._on_connected,
            on_disconnected=self._on_disconnected,
        )

        await self.remove_old_capabilities(CAPABILITIES)
        self._register_capabilities()

        self.log('Initialized.')

    async def on_uninit(self) -> None:
        await self._airplay_logic.uninitialize()
        await self._disconnect()
        self.log('Uninitialized.')

    async def on_discovery_available(self, discovery_result: DiscoveryResultMDNSSD) -> None:
        """Called by Homey when the AirPlay discovery result matches this device."""
        self._discovery_results[AIRPLAY_SERVICE] = discovery_result

        if self._connected_once:
            return

        self._connected_once = True
        await self._connect()

    async def _connect(self) -> None:
        result = self.discovery_result
        if result is None:
            return

        # HomePod uses transient pairing (no persistent credentials required).
        credentials = get_credentials_from_device(self)

        try:
            await self._airplay.connect(
                address=result.address,
                port=result.port,
                txt_properties=dict(result.txt),
                credentials=credentials,
            )
            if self._airplay.atv is not None:
                self._airplay_logic.set_atv(self._airplay.atv)
        except Exception as err:
            self.error('Error connecting to HomePod:', err)
            await self.set_unavailable('Cannot connect to HomePod.')

    async def _disconnect(self) -> None:
        await self._airplay.disconnect()

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
        atv = self._airplay.atv
        if atv:
            await atv.remote_control.next()

    async def _on_speaker_prev(self, _: Any, **__: Any) -> None:
        atv = self._airplay.atv
        if atv:
            await atv.remote_control.previous()

    async def _on_speaker_stop(self, _: Any, **__: Any) -> None:
        atv = self._airplay.atv
        if atv:
            await atv.remote_control.stop()

    async def _on_speaker_playing(self, play: bool, **_: Any) -> None:
        atv = self._airplay.atv
        if atv is None:
            return
        if play:
            await atv.remote_control.play()
        else:
            await atv.remote_control.pause()

    async def _on_volume_up(self, _: Any, **__: Any) -> None:
        atv = self._airplay.atv
        if atv:
            await atv.audio.volume_up()

    async def _on_volume_down(self, _: Any, **__: Any) -> None:
        atv = self._airplay.atv
        if atv:
            await atv.audio.volume_down()

    async def _on_volume_set(self, volume: float, **_: Any) -> None:
        atv = self._airplay.atv
        if atv:
            await atv.audio.set_volume(volume * 100)

    async def _on_restart(self, _: Any, **__: Any) -> None:
        await self._disconnect()
        await self._airplay_logic.clear_now_playing()
        await self._connect()

    async def _on_connected(self) -> None:
        await self.set_available()

    async def _on_disconnected(self, unexpected: bool) -> None:
        if not unexpected:
            return
        self.log('Disconnected from HomePod, reconnecting...')
        await self.set_unavailable('Disconnected from HomePod, reconnecting...')
        await wait_for(1000)

        result = await self.find_service(AIRPLAY_SERVICE)
        if result is not None and self._airplay.atv is None:
            await self._connect()

    async def play_url(self, url: str, volume: float | None = None) -> None:
        """
        Stream a URL to the HomePod via AirPlay.

        :param url: The URL to stream.
        :param volume: Optional volume level (0.0 – 1.0).
        """
        result = self.discovery_result
        if result is None:
            raise RuntimeError('Device not yet discovered; cannot play URL.')

        # If volume is requested, set it first.
        atv = self._airplay.atv
        if atv is not None and volume is not None:
            await atv.audio.set_volume(volume * 100)

        if atv is not None:
            await atv.stream.play_url(url)


homey_export = HomePodBaseDevice
