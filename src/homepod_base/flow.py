from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..app import AppleApp
    from .device import HomePodBaseDevice
    from .driver import HomePodBaseDriver


class HomePodFlow:
    """Registers and manages HomePod flow cards."""

    def __init__(self, app: AppleApp) -> None:
        self._app = app

    def register(self) -> None:
        self._register_play_url()
        self._register_play_url_at_volume()

    async def trigger_artwork_url_updated(
        self,
        device: HomePodBaseDevice,
        local_url: str,
        cloud_url: str,
    ) -> None:
        card = self._app.homey.flow.get_device_trigger_card(
            'homepod_artwork_url_updated'
        )
        await card.trigger(device, {'localUrl': local_url, 'cloudUrl': cloud_url})

    # ------------------------------------------------------------------

    def _register_play_url(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_play_url')

        async def run(args: dict[str, Any]) -> None:
            device: HomePodBaseDevice = args['device']
            url: str = args['url']
            await device.play_url(url)

        card.register_run_listener(run)

    def _register_play_url_at_volume(self) -> None:
        card = self._app.homey.flow.get_action_card('homepod_play_url_at_volume')

        async def run(args: dict[str, Any]) -> None:
            device: HomePodBaseDevice = args['device']
            url: str = args['url']
            volume: float = args['volume']
            await device.play_url(url, volume)

        card.register_run_listener(run)
