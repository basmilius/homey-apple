"""Tests for drivers/apple-tv/device.py"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# The directory is named 'apple-tv' (hyphen) which Python can't import directly.
# Load the module via importlib so we can reference it without renaming the folder.
def _load_apple_tv_device():
    spec = importlib.util.spec_from_file_location(
        'drivers.apple_tv.device',
        Path(__file__).parent.parent / 'drivers' / 'apple-tv' / 'device.py',
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules['drivers.apple_tv.device'] = module
    spec.loader.exec_module(module)
    return module

_mod = _load_apple_tv_device()
AppleTVDevice = _mod.AppleTVDevice
AIRPLAY_SERVICE = _mod.AIRPLAY_SERVICE
COMPANION_SERVICE = _mod.COMPANION_SERVICE


# ---------------------------------------------------------------------------
# Concrete device for testing
# ---------------------------------------------------------------------------

class ConcreteAppleTV(AppleTVDevice):
    """Testable subclass — overrides all Homey SDK calls with no-ops."""

    def __init__(self):
        super().__init__()
        self._unavailable_msg = None
        self._available = False
        self._capabilities: dict = {}
        self._capability_listeners: dict = {}
        self._store: dict = {}
        self._data: dict = {'id': 'test-atv-id'}
        self._airplay_logic = MagicMock()
        self._airplay_logic.stop = MagicMock()
        self._airplay_logic.clear_now_playing = AsyncMock()

    async def set_unavailable(self, msg=''):
        self._unavailable_msg = msg

    async def set_available(self):
        self._available = True

    async def set_capability_value(self, cap, val):
        self._capabilities[cap] = val

    def get_capability_value(self, cap):
        return self._capabilities.get(cap)

    def has_capability(self, cap):
        return cap in self._capabilities

    def get_capabilities(self):
        return list(self._capabilities.keys())

    async def remove_capability(self, cap):
        self._capabilities.pop(cap, None)

    def get_data(self):
        return self._data

    def get_store(self):
        return self._store

    def register_capability_listener(self, cap, fn):
        self._capability_listeners[cap] = fn

    def register_multiple_capability_listener(self, caps, fn, delay=0):
        for cap in caps:
            self._capability_listeners[cap] = fn

    async def set_album_art_image(self, image):
        pass

    def log(self, *args):
        pass

    def error(self, *args):
        pass

    async def trigger_now_playing_app_changed(self, bundle_id, display_name):
        pass

    async def trigger_artwork_url_updated(self, image):
        pass

    async def trigger_companion_link_failed(self):
        pass


# ---------------------------------------------------------------------------
# Capability handlers — null guard (offline)
# ---------------------------------------------------------------------------

class TestCapabilityNullGuard:
    @pytest.mark.asyncio
    async def test_onoff_offline(self):
        device = ConcreteAppleTV()
        await device._on_onoff(True)  # must not raise

    @pytest.mark.asyncio
    async def test_speaker_next_offline(self):
        device = ConcreteAppleTV()
        await device._on_speaker_next()

    @pytest.mark.asyncio
    async def test_speaker_prev_offline(self):
        device = ConcreteAppleTV()
        await device._on_speaker_prev()

    @pytest.mark.asyncio
    async def test_speaker_playing_offline(self):
        device = ConcreteAppleTV()
        await device._on_speaker_playing(True)

    @pytest.mark.asyncio
    async def test_volume_up_offline(self):
        device = ConcreteAppleTV()
        await device._on_volume_up()

    @pytest.mark.asyncio
    async def test_volume_down_offline(self):
        device = ConcreteAppleTV()
        await device._on_volume_down()

    @pytest.mark.asyncio
    async def test_volume_mute_offline(self):
        device = ConcreteAppleTV()
        await device._on_volume_mute()

    @pytest.mark.asyncio
    async def test_volume_set_offline(self):
        device = ConcreteAppleTV()
        await device._on_volume_set(0.5)

    @pytest.mark.asyncio
    async def test_remote_offline(self):
        device = ConcreteAppleTV()
        await device._on_remote({'remote_up': True})


# ---------------------------------------------------------------------------
# Capability handlers — online behaviour
# ---------------------------------------------------------------------------

class TestCapabilityHandlers:
    def _device(self, mock_atv):
        device = ConcreteAppleTV()
        device._atv = mock_atv
        return device

    @pytest.mark.asyncio
    async def test_onoff_true_calls_turn_on(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_onoff(True)
        mock_atv.power.turn_on.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_onoff_false_calls_turn_off(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_onoff(False)
        mock_atv.power.turn_off.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_speaker_next_calls_remote_next(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_speaker_next()
        mock_atv.remote_control.next.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_speaker_prev_calls_remote_previous(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_speaker_prev()
        mock_atv.remote_control.previous.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_speaker_playing_true_calls_play(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_speaker_playing(True)
        mock_atv.remote_control.play.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_speaker_playing_false_calls_pause(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_speaker_playing(False)
        mock_atv.remote_control.pause.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_volume_set_scales_to_pyatv_range(self, mock_atv):
        """Apple TV volume_set: Homey 0.0–1.0 → pyatv 0–100."""
        device = self._device(mock_atv)
        await device._on_volume_set(0.75)
        mock_atv.audio.set_volume.assert_awaited_once_with(75.0)

    @pytest.mark.asyncio
    async def test_volume_mute_sets_volume_zero(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_volume_mute()
        mock_atv.audio.set_volume.assert_awaited_once_with(0)

    @pytest.mark.asyncio
    async def test_remote_up(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_remote({'remote_up': True})
        mock_atv.remote_control.up.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_down(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_remote({'remote_down': True})
        mock_atv.remote_control.down.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_select(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_remote({'remote_select': True})
        mock_atv.remote_control.select.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_home(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_remote({'remote_home': True})
        mock_atv.remote_control.home.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_back_calls_menu(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_remote({'remote_back': True})
        mock_atv.remote_control.menu.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_playpause(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_remote({'remote_playpause': True})
        mock_atv.remote_control.play_pause.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_multiple_buttons_in_one_call(self, mock_atv):
        device = self._device(mock_atv)
        await device._on_remote({'remote_left': True, 'remote_right': True})
        mock_atv.remote_control.left.assert_awaited_once()
        mock_atv.remote_control.right.assert_awaited_once()


# ---------------------------------------------------------------------------
# _get_credentials
# ---------------------------------------------------------------------------

class TestGetCredentials:
    def test_returns_none_when_no_store(self):
        device = ConcreteAppleTV()
        device._store = {}
        assert device._get_credentials() is None

    def test_returns_credential_string(self):
        device = ConcreteAppleTV()
        device._store = {'credentials': 'airplay-creds-xyz'}
        assert device._get_credentials() == 'airplay-creds-xyz'


# ---------------------------------------------------------------------------
# on_service_found — dual-service guard
# ---------------------------------------------------------------------------

class TestOnServiceFound:
    @pytest.mark.asyncio
    async def test_does_not_connect_with_only_airplay(self):
        device = ConcreteAppleTV()
        device._connect = AsyncMock()
        fake_config = MagicMock()
        # Only AirPlay found — Companion not yet in results
        await device.on_service_found(AIRPLAY_SERVICE, fake_config)
        device._connect.assert_not_called()

    @pytest.mark.asyncio
    async def test_does_not_connect_with_only_companion(self):
        device = ConcreteAppleTV()
        device._connect = AsyncMock()
        fake_config = MagicMock()
        await device.on_service_found(COMPANION_SERVICE, fake_config)
        device._connect.assert_not_called()

    @pytest.mark.asyncio
    async def test_connects_when_both_services_found(self):
        device = ConcreteAppleTV()
        device._connect = AsyncMock()
        fake_config = MagicMock()
        # Manually pre-populate both discovery results
        device._discovery_results[AIRPLAY_SERVICE] = fake_config
        device._discovery_results[COMPANION_SERVICE] = fake_config
        # Simulate the second service arriving
        device._connected_once = False
        await device.on_service_found(COMPANION_SERVICE, fake_config)
        device._connect.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_does_not_connect_twice(self):
        device = ConcreteAppleTV()
        device._connect = AsyncMock()
        fake_config = MagicMock()
        device._discovery_results[AIRPLAY_SERVICE] = fake_config
        device._discovery_results[COMPANION_SERVICE] = fake_config
        device._connected_once = True  # already connected
        await device.on_service_found(AIRPLAY_SERVICE, fake_config)
        device._connect.assert_not_called()


# ---------------------------------------------------------------------------
# _on_disconnected
# ---------------------------------------------------------------------------

class TestOnDisconnected:
    @pytest.mark.asyncio
    async def test_unexpected_false_does_nothing(self):
        device = ConcreteAppleTV()
        device._disconnect = AsyncMock()
        await device._on_disconnected(unexpected=False)
        device._disconnect.assert_not_called()

    @pytest.mark.asyncio
    async def test_calls_disconnect_before_reconnect(self):
        device = ConcreteAppleTV()
        call_order = []
        device._disconnect = AsyncMock(side_effect=lambda: call_order.append('disconnect'))
        device.find_service = AsyncMock(side_effect=lambda *a: call_order.append('find'))
        device._connect = AsyncMock(side_effect=lambda: call_order.append('connect'))

        with patch('asyncio.sleep', new=AsyncMock()):
            await device._on_disconnected(unexpected=True)

        assert call_order == ['disconnect', 'find', 'connect']

    @pytest.mark.asyncio
    async def test_does_not_re_enter_when_reconnecting(self):
        device = ConcreteAppleTV()
        device._is_reconnecting = True
        device._disconnect = AsyncMock()
        await device._on_disconnected(unexpected=True)
        device._disconnect.assert_not_called()

    @pytest.mark.asyncio
    async def test_resets_is_reconnecting_on_completion(self):
        device = ConcreteAppleTV()
        device._disconnect = AsyncMock()
        device.find_service = AsyncMock()
        device._connect = AsyncMock()

        with patch('asyncio.sleep', new=AsyncMock()):
            await device._on_disconnected(unexpected=True)

        assert device._is_reconnecting is False


# ---------------------------------------------------------------------------
# _disconnect — companion reconnect task is cancelled
# ---------------------------------------------------------------------------

class TestDisconnect:
    @pytest.mark.asyncio
    async def test_cancels_companion_task(self, mock_atv):
        device = ConcreteAppleTV()
        device._atv = mock_atv
        task = MagicMock()
        task.done = MagicMock(return_value=False)
        task.cancel = MagicMock()
        device._companion_reconnect_task = task

        await device._disconnect()

        task.cancel.assert_called_once()
        assert device._companion_reconnect_task is None

    @pytest.mark.asyncio
    async def test_closes_atv_and_nils_it(self, mock_atv):
        device = ConcreteAppleTV()
        device._atv = mock_atv
        await device._disconnect()
        mock_atv.close.assert_awaited_once()
        assert device._atv is None
