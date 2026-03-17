from __future__ import annotations

from typing import Any

from pyatv.const import Protocol
from pyatv.exceptions import NotSupportedError
from pyatv.protocols.mrp import messages

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

    # ------------------------------------------------------------------
    # Hooks
    # ------------------------------------------------------------------

    async def _on_connected(self) -> None:
        """Fetch and publish initial power and volume state after connecting."""
        if self._atv is None:
            return

        try:
            initial_state = self._atv.power.power_state
            if self._airplay_logic is not None:
                await self._airplay_logic.handle_power_state(initial_state)
        except NotSupportedError:
            self.log('Power state not supported (Companion protocol unavailable).')
        except Exception as err:
            self.error('Failed to fetch initial power state:', err)

        await self._sync_initial_volume()

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
        await self.toggle_mute()

    async def toggle_mute(self) -> None:
        """Toggle mute on the Apple TV via MRP HID event."""
        atv = self._require_atv()

        mrp_interface = atv.remote_control._interfaces.get(Protocol.MRP, None)  # pyright: ignore[reportAttributeAccessIssue]
        if mrp_interface is None:
            raise RuntimeError('MRP interface not available.')

        mrp_protocol = getattr(mrp_interface, 'protocol', None)
        if mrp_protocol is None:
            raise RuntimeError('MRP protocol not available.')

        await mrp_protocol.send(messages.send_hid_event(12, 0xE2, True))  # pyright: ignore[reportAttributeAccessIssue]
        await mrp_protocol.send(messages.send_hid_event(12, 0xE2, False))  # pyright: ignore[reportAttributeAccessIssue]

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
