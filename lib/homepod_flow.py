"""Flow card registrations for HomePod and HomePod Mini."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import homey
    from .homepod_base_device import HomePodBaseDevice

logger = logging.getLogger(__name__)


class HomePodFlow:
    def __init__(self, app: homey.App) -> None:
        self._app = app

    async def register(self) -> None:
        self._register_play_url()
        self._register_play_url_at_volume()
        self._register_seek_to_position()
        self._register_skip_forward()
        self._register_skip_backward()

    async def trigger_artwork_url_updated(
        self,
        device: HomePodBaseDevice,
        local_url: str,
        cloud_url: str,
    ) -> None:
        try:
            card = self._app.homey.flow.get_device_trigger_card('homepod_artwork_url_updated')
            await card.trigger(device, {'localUrl': local_url, 'cloudUrl': cloud_url})
        except Exception as err:
            logger.warning(f'Failed to trigger homepod_artwork_url_updated: {err}')

    # ------------------------------------------------------------------
    # Action cards
    # ------------------------------------------------------------------

    def _register_play_url(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_play_url')

        async def run(args: dict) -> None:
            device: HomePodBaseDevice = args['device']
            if device._atv is None:
                raise RuntimeError('Not connected.')
            await device.play_url(args['url'])

        card.register_run_listener(run)

    def _register_play_url_at_volume(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_play_url_at_volume')

        async def run(args: dict) -> None:
            device: HomePodBaseDevice = args['device']
            if device._atv is None:
                raise RuntimeError('Not connected.')
            await device.play_url(args['url'], args['volume'])

        card.register_run_listener(run)

    def _register_seek_to_position(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_set_position')

        async def run(args: dict) -> None:
            device: HomePodBaseDevice = args['device']
            if device._atv is None:
                raise RuntimeError('Not connected.')
            await device._atv.remote_control.set_position(int(args['position']))

        card.register_run_listener(run)

    def _register_skip_forward(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_skip_forward')

        async def run(args: dict) -> None:
            device: HomePodBaseDevice = args['device']
            if device._atv is None:
                raise RuntimeError('Not connected.')
            await device._atv.remote_control.skip_forward(int(args['seconds']))

        card.register_run_listener(run)

    def _register_skip_backward(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_skip_backward')

        async def run(args: dict) -> None:
            device: HomePodBaseDevice = args['device']
            if device._atv is None:
                raise RuntimeError('Not connected.')
            await device._atv.remote_control.skip_backward(int(args['seconds']))

        card.register_run_listener(run)
