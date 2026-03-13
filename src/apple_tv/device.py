from __future__ import annotations

from typing import Any

from ..base.discoverable_device import DiscoverableDevice

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
    'artwork_url_local',
    'artwork_url_cloud',
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
    'button.repair',
]


class AppleTVDevice(DiscoverableDevice):
    """Homey device representing a paired Apple TV."""

    @property
    def _device_capabilities(self) -> list[str]:
        return CAPABILITIES

    @property
    def _device_type_name(self) -> str:
        return 'Apple TV'

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._last_volume_before_mute: float | None = None

    # ------------------------------------------------------------------
    # Hooks
    # ------------------------------------------------------------------

    async def _on_connected(self) -> None:
        """Fetch and publish initial power state after connecting."""
        if self._atv is None:
            return

        try:
            initial_state = self._atv.power.power_state
            if self._airplay_logic is not None:
                await self._airplay_logic._handle_power_state(initial_state)
        except Exception as err:
            self.error('Failed to fetch initial power state:', err)

    def _get_capability_handlers(self) -> dict[str, Any]:
        handlers = super()._get_capability_handlers()
        handlers.update({
            'onoff': self._on_onoff,
            'volume_mute': self._on_volume_mute,
            'remote_up': self._on_remote_up,
            'remote_down': self._on_remote_down,
            'remote_left': self._on_remote_left,
            'remote_right': self._on_remote_right,
            'remote_select': self._on_remote_select,
            'remote_home': self._on_remote_home,
            'remote_back': self._on_remote_back,
            'remote_playpause': self._on_remote_playpause,
        })
        return handlers

    # -- Power --

    async def _on_onoff(self, value: bool, **_: Any) -> None:
        atv = self._require_atv()
        try:
            if value:
                await atv.power.turn_on()
            else:
                await atv.power.turn_off()
                if self._airplay_logic is not None:
                    await self._airplay_logic.clear_now_playing()
        except Exception as err:
            self.error('Failed to change power state:', err)
            raise

    # -- Volume mute --

    async def _on_volume_mute(self, _: Any, **__: Any) -> None:
        audio = getattr(self._require_atv(), 'audio', None)
        if audio is None:
            raise RuntimeError('Apple TV audio interface not available.')

        is_muting = False
        try:
            current = float(getattr(audio, 'volume', None) or 0.0)
            is_muting = current > 0.0

            if is_muting:
                self._last_volume_before_mute = current
                await audio.set_volume(0.0)
            else:
                restore = self._last_volume_before_mute
                if restore is None or restore <= 0.0:
                    restore = 20.0
                await audio.set_volume(float(restore))
        except Exception as err:
            self.error('Mute toggle via set_volume failed, falling back to volume steps:', err)
            try:
                for _ in range(10):
                    if is_muting:
                        await audio.volume_down()
                    else:
                        await audio.volume_up()
            except Exception as fallback_err:
                self.error('Mute fallback failed:', fallback_err)

    # -- Remote --

    async def _on_remote_up(self, value: bool, **_: Any) -> None:
        if value:
            await self._require_atv().remote_control.up()

    async def _on_remote_down(self, value: bool, **_: Any) -> None:
        if value:
            await self._require_atv().remote_control.down()

    async def _on_remote_left(self, value: bool, **_: Any) -> None:
        if value:
            await self._require_atv().remote_control.left()

    async def _on_remote_right(self, value: bool, **_: Any) -> None:
        if value:
            await self._require_atv().remote_control.right()

    async def _on_remote_select(self, value: bool, **_: Any) -> None:
        if value:
            await self._require_atv().remote_control.select()

    async def _on_remote_home(self, value: bool, **_: Any) -> None:
        if value:
            await self._require_atv().remote_control.home()

    async def _on_remote_back(self, value: bool, **_: Any) -> None:
        if value:
            await self._require_atv().remote_control.menu()

    async def _on_remote_playpause(self, value: bool, **_: Any) -> None:
        if value:
            await self._require_atv().remote_control.play_pause()


homey_export = AppleTVDevice
