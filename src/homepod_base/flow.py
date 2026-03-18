from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import pyatv.interface as pyatv_interface

if TYPE_CHECKING:
    from ..app import AppleApp
    from .device import HomePodBaseDevice


def _require_atv(args: dict[str, Any], label: str) -> tuple[HomePodBaseDevice, pyatv_interface.AppleTV]:
    """Extract device and active pyatv connection from flow args, or raise."""
    device: HomePodBaseDevice = args['device']
    atv = device.atv
    if atv is None:
        raise RuntimeError(f'{label} "{device.get_name()}" is not connected')
    return device, atv


class HomePodFlow:
    """Registers and manages HomePod flow cards."""

    def __init__(self, app: AppleApp) -> None:
        self._app = app

    def register(self) -> None:
        self._register_play_url()
        self._register_play_url_at_volume()
        self._register_set_position()
        self._register_skip_forward()
        self._register_skip_backward()

    async def trigger_artwork_url_updated(
        self,
        device: HomePodBaseDevice,
        local_url: str,
        cloud_url: str,
    ) -> None:
        try:
            card = self._app.homey.flow.get_device_trigger_card(
                'homepod_artwork_url_updated'
            )
            await card.trigger(device, {'localUrl': local_url, 'cloudUrl': cloud_url})
        except asyncio.CancelledError:
            raise
        except Exception as err:
            self._app.log(device.get_name(), 'Failed to trigger artwork url updated card.', err)

    # ------------------------------------------------------------------
    # Action card registrations
    # ------------------------------------------------------------------

    def _register_play_url(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_play_url')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            device: HomePodBaseDevice = args['device']
            url: str = args['url']
            await device.play_url(url)

        card.register_run_listener(run)

    def _register_play_url_at_volume(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_play_url_at_volume')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            device: HomePodBaseDevice = args['device']
            url: str = args['url']
            volume: float = args['volume']
            await device.play_url(url, volume)

        card.register_run_listener(run)

    def _register_set_position(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_set_position')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'HomePod')
            await atv.remote_control.set_position(int(float(args['position'])))

        card.register_run_listener(run)

    def _register_skip_forward(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_skip_forward')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'HomePod')
            await atv.remote_control.skip_forward(int(float(args['seconds'])))

        card.register_run_listener(run)

    def _register_skip_backward(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_skip_backward')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'HomePod')
            await atv.remote_control.skip_backward(int(float(args['seconds'])))

        card.register_run_listener(run)
