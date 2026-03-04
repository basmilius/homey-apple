from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import pyatv.const as pyatv_const
from pyatv.const import DeviceState

from ..base.discoverable_device import (
    AIRPLAY_SERVICE,
    COMPANION_LINK_SERVICE,
    DiscoverableDevice,
)
from ..connection.airplay import AirPlayConnection, CompanionLinkConnection
from ..logic.airplay import AirPlayLogic
from ..utils.get_credentials_from_device import get_credentials_from_device
from ..utils.wait_for import wait_for

if TYPE_CHECKING:
    from homey.discovery_result_mdns_sd import DiscoveryResultMDNSSD

    from .driver import AppleTVDriver

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
    'button.restart',
]


class AppleTVDevice(DiscoverableDevice):
    """Homey device representing a paired Apple TV."""

    @property
    def airplay(self) -> AirPlayConnection:
        return self._airplay

    @property
    def airplay_logic(self) -> AirPlayLogic:
        return self._airplay_logic

    @property
    def companion_link(self) -> CompanionLinkConnection:
        return self._companion_link

    @property
    def discovery_result_airplay(self) -> DiscoveryResultMDNSSD | None:
        return self.discovery_results.get(AIRPLAY_SERVICE)

    @property
    def discovery_result_companion_link(self) -> DiscoveryResultMDNSSD | None:
        return self.discovery_results.get(COMPANION_LINK_SERVICE)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._airplay: AirPlayConnection = None  # type: ignore[assignment]
        self._airplay_logic: AirPlayLogic = None  # type: ignore[assignment]
        self._companion_link: CompanionLinkConnection = None  # type: ignore[assignment]
        self._companion_link_failed = False
        self._connected_once = False

    async def on_init(self) -> None:
        await self.set_unavailable('Connecting...')

        from ..app import AppleApp
        app: AppleApp = AppleApp._instance  # type: ignore[assignment]

        self._airplay_logic = AirPlayLogic(self, app)
        await self._airplay_logic.initialize()

        self._airplay = AirPlayConnection(self)
        self._airplay.set_callbacks(
            on_connected=self._on_airplay_connected,
            on_disconnected=self._on_airplay_disconnected,
        )

        self._companion_link = CompanionLinkConnection(self)
        self._companion_link.set_callbacks(
            on_connected=self._on_companion_link_connected,
            on_disconnected=self._on_companion_link_disconnected,
            on_failed=self._on_companion_link_failed,
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
            # Already connected; update the stored AirPlay result only.
            return

        # Try to also find the companion-link service.
        try:
            await self.find_service(COMPANION_LINK_SERVICE, update=False)
        except Exception as err:
            self.error('Could not find companion-link service:', err)

        if self.discovery_result_airplay and self.discovery_result_companion_link:
            self._connected_once = True
            await self._connect()

    async def refresh_companion_link_discovery(self) -> None:
        """Re-look-up the companion-link discovery result and reconnect."""
        result = await self.find_service(COMPANION_LINK_SERVICE)
        if result is not None:
            await self._connect_companion_link()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _connect(self) -> None:
        credentials = get_credentials_from_device(self)

        if credentials is None:
            await self.set_unavailable(
                'Cannot find credentials, please re-pair the device.'
            )
            return

        try:
            airplay_result = self.discovery_result_airplay
            self.log('Connecting to Apple TV (AirPlay)...')
            await self._airplay.connect(
                address=airplay_result.address,
                port=airplay_result.port,
                txt_properties=dict(airplay_result.txt),
                credentials=credentials,
            )
            # Attach pyatv interface to the logic layer for push updates.
            if self._airplay.atv is not None:
                self._airplay_logic.set_atv(self._airplay.atv)
        except Exception as err:
            self.error('Error connecting via AirPlay:', err)
            await self.set_unavailable('Cannot connect to Apple TV (AirPlay).')
            return

        await self._connect_companion_link()

    async def _connect_companion_link(self) -> None:
        credentials = get_credentials_from_device(self)

        companion_result = self.discovery_result_companion_link
        if companion_result is None:
            return

        try:
            self.log('Connecting to Apple TV (Companion Link)...')
            await self._companion_link.connect(
                address=companion_result.address,
                port=companion_result.port,
                txt_properties=dict(companion_result.txt),
                credentials=credentials,
            )
        except Exception as err:
            self.error('Error connecting via Companion Link:', err)
            await self.set_unavailable('Cannot connect to Apple TV (Companion Link).')

    async def _disconnect(self) -> None:
        await self._airplay.disconnect()
        await self._companion_link.disconnect()

    def _register_capabilities(self) -> None:
        self._register_on_off()
        self._register_remote()

        self.register_capability_listener('speaker_next', self._on_speaker_next)
        self.register_capability_listener('speaker_prev', self._on_speaker_prev)
        self.register_capability_listener('speaker_stop', self._on_speaker_stop)
        self.register_capability_listener('speaker_playing', self._on_speaker_playing)
        self.register_capability_listener('volume_up', self._on_volume_up)
        self.register_capability_listener('volume_down', self._on_volume_down)
        self.register_capability_listener('volume_mute', self._on_volume_mute)
        self.register_capability_listener('button.restart', self._on_restart)

    def _register_on_off(self) -> None:
        self.register_capability_listener('onoff', self._on_onoff)

    def _register_remote(self) -> None:
        remote_keys = [cap for cap in CAPABILITIES if cap.startswith('remote_')]
        self.register_multiple_capability_listener(
            remote_keys, self._on_remote, debounce_timeout=0
        )

    # ------------------------------------------------------------------
    # Capability listeners
    # ------------------------------------------------------------------

    async def _on_onoff(self, value: bool, **_: Any) -> None:
        atv = self._airplay.atv
        if atv is None:
            return
        if value:
            await atv.power.turn_on()
        else:
            await atv.power.turn_off()

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
            await atv.remote_control.volume_up()

    async def _on_volume_down(self, _: Any, **__: Any) -> None:
        atv = self._airplay.atv
        if atv:
            await atv.remote_control.volume_down()

    async def _on_volume_mute(self, _: Any, **__: Any) -> None:
        # pyatv does not have a dedicated mute command; volume_down is a best effort.
        atv = self._airplay.atv
        if atv:
            await atv.remote_control.volume_down()

    async def _on_remote(self, values: dict, **_: Any) -> None:
        atv = self._airplay.atv
        if atv is None:
            return
        rc = atv.remote_control
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

    async def _on_restart(self, _: Any, **__: Any) -> None:
        try:
            await self._disconnect()
            await self._airplay_logic.clear_now_playing()
            await self._connect()
        except Exception as err:
            self.error(err)

    # ------------------------------------------------------------------
    # Connection event handlers
    # ------------------------------------------------------------------

    async def _on_connected(self) -> None:
        if not self._airplay.is_connected or not self._companion_link.is_connected:
            return
        await self.set_available()

    async def _on_airplay_connected(self) -> None:
        self.log('Connected to Apple TV (AirPlay).')
        await self._on_connected()

    async def _on_airplay_disconnected(self, unexpected: bool) -> None:
        if not unexpected:
            return
        self.log('Disconnected from Apple TV (AirPlay), reconnecting...')
        await self.set_unavailable('Disconnected from Apple TV (AirPlay), reconnecting...')
        await wait_for(1000)

        result = await self.find_service(AIRPLAY_SERVICE)
        if result is not None and self._airplay.atv is None:
            credentials = get_credentials_from_device(self)
            await self._airplay.connect(
                address=result.address,
                port=result.port,
                txt_properties=dict(result.txt),
                credentials=credentials,
            )
            if self._airplay.atv is not None:
                self._airplay_logic.set_atv(self._airplay.atv)

    async def _on_companion_link_connected(self) -> None:
        self.log('Connected to Apple TV (Companion Link).')
        await self._on_connected()

    async def _on_companion_link_disconnected(self, unexpected: bool) -> None:
        if not unexpected:
            return
        self.log('Disconnected from Apple TV (Companion Link), reconnecting...')
        await self.set_unavailable(
            'Disconnected from Apple TV (Companion Link), reconnecting...'
        )
        await wait_for(1000)

        result = await self.find_service(COMPANION_LINK_SERVICE)
        if result is not None:
            await self._connect_companion_link()

    async def _on_companion_link_failed(self) -> None:
        if self._companion_link_failed:
            return
        self._companion_link_failed = True

        msg = (
            'Failed to connect to Apple TV using Companion Link. '
            'This is probably caused by a port change. '
            'Please restart the app.'
        )
        self.log(msg)
        await self.set_unavailable(msg)

        from ..app import AppleApp
        app: AppleApp = AppleApp._instance  # type: ignore[assignment]
        await app.apple_tv_flow.trigger_companion_link_failed(self)


homey_export = AppleTVDevice
