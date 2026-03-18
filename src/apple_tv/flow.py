from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from pyatv.const import InputAction, RepeatState, ShuffleState


import pyatv.interface as pyatv_interface

if TYPE_CHECKING:
    from ..app import AppleApp
    from .device import AppleTVDevice

# Maps flow command names to remote_control method names.
_REPEAT_MAP: dict[str, RepeatState] = {
    'off': RepeatState.Off,
    'one': RepeatState.Track,
    'all': RepeatState.All,
}

_REMOTE_COMMAND_METHODS: dict[str, str] = {
    'up': 'up',
    'down': 'down',
    'left': 'left',
    'right': 'right',
    'select': 'select',
    'menu': 'menu',
    'home': 'home',
    'play': 'play',
    'pause': 'pause',
    'playPause': 'play_pause',
    'next': 'next',
    'previous': 'previous',
    'volumeUp': 'volume_up',
    'volumeDown': 'volume_down',
}


def _require_atv(args: dict[str, Any], label: str) -> tuple[AppleTVDevice, pyatv_interface.AppleTV]:
    """Extract device and active pyatv connection from flow args, or raise."""
    device: AppleTVDevice = args['device']
    atv = device.atv
    if atv is None:
        raise RuntimeError(f'{label} "{device.get_name()}" is not connected')
    return device, atv


class AppleTVFlow:
    """Registers and manages Apple TV flow cards."""

    def __init__(self, app: AppleApp) -> None:
        self._app = app

    def register(self) -> None:
        self._register_launch_app()
        self._register_launch_url()
        self._register_remote()
        self._register_set_position()
        self._register_skip_forward()
        self._register_skip_backward()
        self._register_set_repeat()
        self._register_set_shuffle()
        self._register_switch_account()

    async def trigger_artwork_url_updated(
        self, device: AppleTVDevice, local_url: str, cloud_url: str
    ) -> None:
        try:
            card = self._app.homey.flow.get_device_trigger_card(
                'appletv_artwork_url_updated'
            )
            await card.trigger(device, {'localUrl': local_url, 'cloudUrl': cloud_url})
        except asyncio.CancelledError:
            raise
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
        except asyncio.CancelledError:
            raise
        except Exception as err:
            self._app.log(
                device.get_name(), 'Failed to trigger now playing app changes card.', err
            )

    # ------------------------------------------------------------------
    # Action card registrations
    # ------------------------------------------------------------------

    def _register_launch_app(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_launch_app')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            device, atv = _require_atv(args, 'Apple TV')
            app_arg: Any = args.get('app')
            if not isinstance(app_arg, dict) or 'id' not in app_arg:
                raise ValueError('No app selected')
            await atv.apps.launch_app(app_arg['id'])

        async def autocomplete(query: str, **kwargs: Any) -> list[dict]:
            device: AppleTVDevice = kwargs['device']
            atv = device.atv
            if atv is None:
                return []
            try:
                app_list = await atv.apps.app_list()
            except Exception:
                return []
            results = [
                {
                    'id': a.identifier,
                    'name': a.name,
                    'description': a.identifier,
                }
                for a in app_list
                if not query.strip() or query.lower() in (a.name or '').lower()
            ]
            return sorted(results, key=lambda x: x['name'] or '')

        card.register_run_listener(run)
        card.get_argument('app').register_autocomplete_listener(autocomplete)

    def _register_launch_url(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_launch_url')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'Apple TV')
            url: str = args['url']
            await atv.apps.launch_app(url)

        card.register_run_listener(run)

    def _register_remote(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_remote')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            device, atv = _require_atv(args, 'Apple TV')
            command: str = args['command']

            rc = atv.remote_control

            method_name = _REMOTE_COMMAND_METHODS.get(command)
            if method_name is not None:
                await getattr(rc, method_name)()
                return

            # Commands that use different interfaces or methods.
            if command == 'stop':
                await rc.stop()
            elif command == 'screensaver':
                await rc.screensaver()
            elif command == 'topMenu':
                await rc.top_menu()
            elif command == 'homeHold':
                await rc.home_hold()
            elif command == 'doubleTapSelect':
                await rc.select(action=InputAction.DoubleTap)
            elif command == 'channelUp':
                await rc.channel_up()
            elif command == 'channelDown':
                await rc.channel_down()
            elif command == 'siri':
                # NOTE: Siri uses internal pyatv API (rc.api / HidCommand.Siri) as
                # there is no public/stable Siri interface in pyatv as of 0.17.x.
                # This may break with future pyatv updates.
                if hasattr(rc, 'api'):
                    from pyatv.protocols.companion.api import HidCommand
                    await rc.api.hid_command(True, HidCommand.Siri)
                    await rc.api.hid_command(False, HidCommand.Siri)
                else:
                    self._app.log(device.get_name(), 'Siri requires Companion Link protocol')
            elif command == 'mute':
                await device.toggle_mute()
            elif command == 'wake':
                await atv.power.turn_on()
            elif command == 'suspend':
                await atv.power.turn_off()
            else:
                raise ValueError(f'Unsupported remote command: {command}')

        card.register_run_listener(run)

    def _register_set_position(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_set_position')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'Apple TV')
            await atv.remote_control.set_position(int(float(args['position'])))

        card.register_run_listener(run)

    def _register_skip_forward(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_skip_forward')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'Apple TV')
            await atv.remote_control.skip_forward(int(float(args['seconds'])))

        card.register_run_listener(run)

    def _register_skip_backward(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_skip_backward')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'Apple TV')
            await atv.remote_control.skip_backward(int(float(args['seconds'])))

        card.register_run_listener(run)

    def _register_set_repeat(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_set_repeat')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'Apple TV')
            mode = args['mode']
            if mode not in _REPEAT_MAP:
                raise ValueError(f'Unsupported repeat mode: {mode!r}')
            await atv.remote_control.set_repeat(_REPEAT_MAP[mode])

        card.register_run_listener(run)

    def _register_set_shuffle(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_set_shuffle')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'Apple TV')
            shuffle = str(args['shuffle']).lower() == 'true'
            state = ShuffleState.Songs if shuffle else ShuffleState.Off
            await atv.remote_control.set_shuffle(state)

        card.register_run_listener(run)

    def _register_switch_account(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_switch_account')

        async def run(args: dict[str, Any], **kwargs: Any) -> None:
            _, atv = _require_atv(args, 'Apple TV')
            account: Any = args.get('account')
            if not isinstance(account, dict) or 'id' not in account:
                raise ValueError('No account selected')

            await atv.user_accounts.switch_account(account['id'])

        async def autocomplete(query: str, **kwargs: Any) -> list[dict]:
            device: AppleTVDevice = kwargs['device']
            atv = device.atv
            if atv is None:
                return []
            try:
                accounts = await atv.user_accounts.account_list()
            except Exception:
                return []
            results = [
                {'id': a.identifier, 'name': a.name}
                for a in accounts
                if not query.strip() or query.lower() in (a.name or '').lower()
            ]
            return sorted(results, key=lambda x: x['name'] or '')

        card.register_run_listener(run)
        card.get_argument('account').register_autocomplete_listener(autocomplete)
