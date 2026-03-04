from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..app import AppleApp
    from .device import AppleTVDevice


class AppleTVFlow:
    """Registers and manages Apple TV flow cards."""

    def __init__(self, app: AppleApp) -> None:
        self._app = app

    def register(self) -> None:
        self._register_launch_app()
        self._register_launch_url()
        self._register_remote()
        self._register_switch_account()

    async def trigger_companion_link_failed(self, device: AppleTVDevice) -> None:
        card = self._app.homey.flow.get_device_trigger_card(
            'appletv_companion_link_failed'
        )
        await card.trigger(device)

    async def trigger_artwork_url_updated(
        self, device: AppleTVDevice, local_url: str, cloud_url: str
    ) -> None:
        try:
            card = self._app.homey.flow.get_device_trigger_card(
                'appletv_artwork_url_updated'
            )
            await card.trigger(device, {'localUrl': local_url, 'cloudUrl': cloud_url})
        except Exception as err:
            self._app.log(device.get_name(), 'Failed to trigger artwork url updated card.', err)

    async def trigger_now_playing_app_changes(
        self,
        device: AppleTVDevice,
        bundle_identifier: str,
        display_name: str,
    ) -> None:
        try:
            card = self._app.homey.flow.get_device_trigger_card(
                'appletv_now_playing_app_changes'
            )
            await card.trigger(
                device,
                {'bundleIdentifier': bundle_identifier, 'displayName': display_name},
            )
        except Exception as err:
            self._app.log(
                device.get_name(), 'Failed to trigger now playing app changes card.', err
            )

    # ------------------------------------------------------------------
    # Private registration helpers
    # ------------------------------------------------------------------

    def _register_launch_app(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_launch_app')

        async def run(args: dict[str, Any]) -> None:
            device: AppleTVDevice = args['device']
            app_arg: Any = args['app']
            atv = device.companion_link.atv
            if atv is not None:
                await atv.apps.launch_app(app_arg['id'])

        async def autocomplete(query: str, args: dict[str, Any]) -> list[dict]:
            device: AppleTVDevice = args['device']
            atv = device.companion_link.atv
            if atv is None:
                return []
            app_list = await atv.apps.app_list()
            results = [
                {
                    'id': a.bundle_identifier,
                    'name': a.name,
                    'description': a.bundle_identifier,
                }
                for a in app_list
                if not query.strip() or query.lower() in a.name.lower()
            ]
            return sorted(results, key=lambda x: x['name'])

        card.register_run_listener(run)
        card.get_argument('app').register_autocomplete_listener(autocomplete)

    def _register_launch_url(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_launch_url')

        async def run(args: dict[str, Any]) -> None:
            device: AppleTVDevice = args['device']
            url: str = args['url']
            atv = device.airplay.atv
            if atv is not None:
                await atv.stream.play_url(url)

        card.register_run_listener(run)

    def _register_remote(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_remote')

        async def run(args: dict[str, Any]) -> None:
            device: AppleTVDevice = args['device']
            command: str = args['command']
            atv = device.airplay.atv
            if atv is None:
                return
            rc = atv.remote_control
            _REMOTE_COMMANDS = {
                'up': rc.up,
                'down': rc.down,
                'left': rc.left,
                'right': rc.right,
                'select': rc.select,
                'menu': rc.menu,
                'home': rc.home,
                'play': rc.play,
                'pause': rc.pause,
                'playPause': rc.play_pause,
                'next': rc.next,
                'previous': rc.previous,
                'volumeUp': rc.volume_up,
                'volumeDown': rc.volume_down,
                'wake': rc.wakeup,
                'suspend': rc.suspend,
            }
            handler = _REMOTE_COMMANDS.get(command)
            if handler is not None:
                await handler()

        card.register_run_listener(run)

    def _register_switch_account(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_switch_account')

        async def run(args: dict[str, Any]) -> None:
            device: AppleTVDevice = args['device']
            account: Any = args['account']
            atv = device.companion_link.atv
            if atv is not None:
                await atv.user_accounts.switch_account(account['id'])

        async def autocomplete(query: str, args: dict[str, Any]) -> list[dict]:
            device: AppleTVDevice = args['device']
            atv = device.companion_link.atv
            if atv is None:
                return []
            accounts = await atv.user_accounts.account_list()
            results = [
                {'id': a.identifier, 'name': a.name}
                for a in accounts
                if not query.strip() or query.lower() in a.name.lower()
            ]
            return sorted(results, key=lambda x: x['name'])

        card.register_run_listener(run)
        card.get_argument('account').register_autocomplete_listener(autocomplete)
