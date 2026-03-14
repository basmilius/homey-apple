"""Apple TV flow card registrations."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from pyatv.const import RepeatState, ShuffleState

if TYPE_CHECKING:
    import homey
    from drivers.apple_tv.device import AppleTVDevice  # type: ignore[import]

logger = logging.getLogger(__name__)


class AppleTVFlow:
    def __init__(self, app: homey.App) -> None:
        self._app = app

    async def register(self) -> None:
        self._register_launch_app()
        self._register_launch_url()
        self._register_remote()
        self._register_seek_to_position()
        self._register_skip_forward()
        self._register_skip_backward()
        self._register_set_repeat()
        self._register_set_shuffle()
        self._register_switch_account()

    # ------------------------------------------------------------------
    # Triggers
    # ------------------------------------------------------------------

    async def trigger_companion_link_failed(self, device) -> None:
        try:
            card = self._app.homey.flow.get_device_trigger_card('appletv_companion_link_failed')
            await card.trigger(device)
        except Exception as err:
            logger.warning(f'Failed to trigger appletv_companion_link_failed: {err}')

    async def trigger_artwork_url_updated(
        self,
        device,
        local_url: str,
        cloud_url: str,
    ) -> None:
        try:
            card = self._app.homey.flow.get_device_trigger_card('appletv_artwork_url_updated')
            await card.trigger(device, {'localUrl': local_url, 'cloudUrl': cloud_url})
        except Exception as err:
            logger.warning(f'Failed to trigger appletv_artwork_url_updated: {err}')

    async def trigger_now_playing_app_changes(
        self,
        device,
        bundle_id: str,
        display_name: str,
    ) -> None:
        try:
            card = self._app.homey.flow.get_device_trigger_card('appletv_now_playing_app_changes')
            await card.trigger(device, {'bundleIdentifier': bundle_id, 'displayName': display_name})
        except Exception as err:
            logger.warning(f'Failed to trigger appletv_now_playing_app_changes: {err}')

    # ------------------------------------------------------------------
    # Action cards
    # ------------------------------------------------------------------

    def _register_launch_app(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_launch_app')

        async def run(args: dict) -> None:
            device = args['device']
            if device._atv is None:
                return
            await device._atv.apps.launch_app(args['app']['id'])

        async def autocomplete_app(query: str, args: dict):
            device = args['device']
            if device._atv is None:
                return []
            apps = await device._atv.apps.app_list()
            results = [
                {'id': a.identifier, 'name': a.name, 'description': a.identifier}
                for a in apps
                if not query.strip() or query.lower() in a.name.lower()
            ]
            return sorted(results, key=lambda x: x['name'])

        card.register_run_listener(run)
        card.register_argument_autocomplete_listener('app', autocomplete_app)

    def _register_launch_url(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_launch_url')

        async def run(args: dict) -> None:
            device = args['device']
            if device._atv is None:
                return
            # Stream the URL via AirPlay using pyatv's stream interface
            await device._atv.stream.play_url(args['url'])

        card.register_run_listener(run)

    def _register_remote(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_remote')

        _COMMAND_MAP = {
            'up': lambda rc: rc.up(),
            'down': lambda rc: rc.down(),
            'left': lambda rc: rc.left(),
            'right': lambda rc: rc.right(),
            'select': lambda rc: rc.select(),
            'menu': lambda rc: rc.menu(),
            'home': lambda rc: rc.home(),
            'play': lambda rc: rc.play(),
            'pause': lambda rc: rc.pause(),
            'playPause': lambda rc: rc.play_pause(),
            'next': lambda rc: rc.next(),
            'previous': lambda rc: rc.previous(),
            'volumeUp': lambda rc: rc.volume_up(),
            'volumeDown': lambda rc: rc.volume_down(),
            'wake': lambda pwr: pwr.turn_on(),
            'suspend': lambda pwr: pwr.turn_off(),
            'screensaver': lambda rc: rc.screensaver(),
            'homeHold': lambda rc: rc.home_hold(),
            'topMenu': lambda rc: rc.top_menu(),
            'channelUp': lambda rc: rc.channel_up(),
            'channelDown': lambda rc: rc.channel_down(),
        }

        async def run(args: dict) -> None:
            device = args['device']
            if device._atv is None:
                return
            command = args['command']
            rc = device._atv.remote_control
            pwr = device._atv.power

            handler = _COMMAND_MAP.get(command)
            if handler is None:
                logger.warning(f'Unknown remote command: {command}')
                return

            if command in ('wake', 'suspend'):
                await handler(pwr)
            else:
                await handler(rc)

        card.register_run_listener(run)

    def _register_seek_to_position(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_set_position')

        async def run(args: dict) -> None:
            device = args['device']
            if device._atv is None:
                return
            await device._atv.remote_control.set_position(int(args['position']))

        card.register_run_listener(run)

    def _register_skip_forward(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_skip_forward')

        async def run(args: dict) -> None:
            device = args['device']
            if device._atv is None:
                return
            await device._atv.remote_control.skip_forward(int(args['seconds']))

        card.register_run_listener(run)

    def _register_skip_backward(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_skip_backward')

        async def run(args: dict) -> None:
            device = args['device']
            if device._atv is None:
                return
            await device._atv.remote_control.skip_backward(int(args['seconds']))

        card.register_run_listener(run)

    def _register_set_repeat(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_set_repeat')

        _REPEAT_MAP = {
            'off': RepeatState.Off,
            'one': RepeatState.Track,
            'all': RepeatState.All,
        }

        async def run(args: dict) -> None:
            device = args['device']
            if device._atv is None:
                return
            repeat_state = _REPEAT_MAP.get(args['mode'], RepeatState.Off)
            await device._atv.remote_control.set_repeat(repeat_state)

        card.register_run_listener(run)

    def _register_set_shuffle(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_set_shuffle')

        async def run(args: dict) -> None:
            device = args['device']
            if device._atv is None:
                return
            shuffle = args['shuffle'] == 'true' or args['shuffle'] is True
            state = ShuffleState.Songs if shuffle else ShuffleState.Off
            await device._atv.remote_control.set_shuffle(state)

        card.register_run_listener(run)

    def _register_switch_account(self) -> None:
        card = self._app.homey.flow.get_action_card('appletv_switch_account')

        async def run(args: dict) -> None:
            device = args['device']
            if device._atv is None:
                return
            await device._atv.user_accounts.switch_account(args['account']['id'])

        async def autocomplete_account(query: str, args: dict):
            device = args['device']
            if device._atv is None:
                return []
            accounts = await device._atv.user_accounts.account_list()
            results = [
                {'id': a.account_id, 'name': a.name}
                for a in accounts
                if not query.strip() or query.lower() in a.name.lower()
            ]
            return sorted(results, key=lambda x: x['name'])

        card.register_run_listener(run)
        card.register_argument_autocomplete_listener('account', autocomplete_account)
