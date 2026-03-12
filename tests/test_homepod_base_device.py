"""Tests for lib/homepod_base_device.py"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

# conftest patches sys.modules['homey'] before these imports
from lib.homepod_base_device import HomePodBaseDevice


# ---------------------------------------------------------------------------
# Concrete subclass for testing (HomePodBaseDevice is abstract)
# ---------------------------------------------------------------------------

class ConcreteHomePod(HomePodBaseDevice):
    """Minimal concrete device used in tests."""

    @property
    def services(self):
        return ['airplay']

    # Override SDK methods to be async no-ops and trackable
    def __init__(self):
        super().__init__()
        self._unavailable_msg = None
        self._available = False
        self._capabilities: dict = {}
        self._capability_listeners: dict = {}
        self._store: dict = {}
        self._data: dict = {'id': 'test-homepod-id'}
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


# ---------------------------------------------------------------------------
# Capability handlers — null guard (offline)
# ---------------------------------------------------------------------------

class TestCapabilityNullGuard:
    """All capability handlers must return silently when _atv is None."""

    @pytest.mark.asyncio
    async def test_speaker_next_offline(self):
        device = ConcreteHomePod()
        await device._on_speaker_next()  # must not raise

    @pytest.mark.asyncio
    async def test_speaker_prev_offline(self):
        device = ConcreteHomePod()
        await device._on_speaker_prev()

    @pytest.mark.asyncio
    async def test_speaker_stop_offline(self):
        device = ConcreteHomePod()
        await device._on_speaker_stop()

    @pytest.mark.asyncio
    async def test_speaker_playing_true_offline(self):
        device = ConcreteHomePod()
        await device._on_speaker_playing(True)

    @pytest.mark.asyncio
    async def test_speaker_playing_false_offline(self):
        device = ConcreteHomePod()
        await device._on_speaker_playing(False)

    @pytest.mark.asyncio
    async def test_volume_up_offline(self):
        device = ConcreteHomePod()
        await device._on_volume_up()

    @pytest.mark.asyncio
    async def test_volume_down_offline(self):
        device = ConcreteHomePod()
        await device._on_volume_down()

    @pytest.mark.asyncio
    async def test_volume_set_offline(self):
        device = ConcreteHomePod()
        await device._on_volume_set(0.5)


# ---------------------------------------------------------------------------
# Capability handlers — online behaviour
# ---------------------------------------------------------------------------

class TestCapabilityHandlers:
    def _device_with_atv(self, mock_atv):
        device = ConcreteHomePod()
        device._atv = mock_atv
        return device

    @pytest.mark.asyncio
    async def test_speaker_next_calls_remote_next(self, mock_atv):
        device = self._device_with_atv(mock_atv)
        await device._on_speaker_next()
        mock_atv.remote_control.next.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_speaker_prev_calls_remote_previous(self, mock_atv):
        device = self._device_with_atv(mock_atv)
        await device._on_speaker_prev()
        mock_atv.remote_control.previous.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_speaker_stop_calls_remote_stop(self, mock_atv):
        device = self._device_with_atv(mock_atv)
        await device._on_speaker_stop()
        mock_atv.remote_control.stop.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_speaker_playing_true_calls_play(self, mock_atv):
        device = self._device_with_atv(mock_atv)
        await device._on_speaker_playing(True)
        mock_atv.remote_control.play.assert_awaited_once()
        mock_atv.remote_control.pause.assert_not_called()

    @pytest.mark.asyncio
    async def test_speaker_playing_false_calls_pause(self, mock_atv):
        device = self._device_with_atv(mock_atv)
        await device._on_speaker_playing(False)
        mock_atv.remote_control.pause.assert_awaited_once()
        mock_atv.remote_control.play.assert_not_called()

    @pytest.mark.asyncio
    async def test_volume_up_calls_audio_volume_up(self, mock_atv):
        device = self._device_with_atv(mock_atv)
        await device._on_volume_up()
        mock_atv.audio.volume_up.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_volume_down_calls_audio_volume_down(self, mock_atv):
        device = self._device_with_atv(mock_atv)
        await device._on_volume_down()
        mock_atv.audio.volume_down.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_volume_set_scales_to_pyatv_range(self, mock_atv):
        """Homey sends 0.0–1.0; pyatv expects 0–100."""
        device = self._device_with_atv(mock_atv)
        await device._on_volume_set(0.5)
        mock_atv.audio.set_volume.assert_awaited_once_with(50.0)

    @pytest.mark.asyncio
    async def test_volume_set_full_scale(self, mock_atv):
        device = self._device_with_atv(mock_atv)
        await device._on_volume_set(1.0)
        mock_atv.audio.set_volume.assert_awaited_once_with(100.0)

    @pytest.mark.asyncio
    async def test_volume_set_zero(self, mock_atv):
        device = self._device_with_atv(mock_atv)
        await device._on_volume_set(0.0)
        mock_atv.audio.set_volume.assert_awaited_once_with(0.0)


# ---------------------------------------------------------------------------
# play_url
# ---------------------------------------------------------------------------

class TestPlayUrl:
    @pytest.mark.asyncio
    async def test_raises_when_not_connected(self):
        device = ConcreteHomePod()
        with pytest.raises(RuntimeError, match='Not connected'):
            await device.play_url('http://example.com/audio.mp3')

    @pytest.mark.asyncio
    async def test_passes_volume_directly_no_scaling(self, mock_atv):
        """Flow card volume is already 0–100; pyatv also expects 0–100 — no scaling."""
        device = ConcreteHomePod()
        device._atv = mock_atv
        # Close the streaming coroutine so Python doesn't warn about unawaited coro.
        def _consume(coro): coro.close()
        with patch('lib.homepod_base_device.asyncio.create_task', side_effect=_consume):
            await device.play_url('http://example.com/a.mp3', volume=75.0)
        mock_atv.audio.set_volume.assert_awaited_once_with(75.0)

    @pytest.mark.asyncio
    async def test_skips_volume_when_none(self, mock_atv):
        device = ConcreteHomePod()
        device._atv = mock_atv
        def _consume(coro): coro.close()
        with patch('lib.homepod_base_device.asyncio.create_task', side_effect=_consume):
            await device.play_url('http://example.com/a.mp3', volume=None)
        mock_atv.audio.set_volume.assert_not_called()


# ---------------------------------------------------------------------------
# _get_credentials
# ---------------------------------------------------------------------------

class TestGetCredentials:
    def test_returns_none_when_no_store(self):
        device = ConcreteHomePod()
        device._store = {}
        assert device._get_credentials() is None

    def test_returns_none_when_store_has_no_credentials(self):
        device = ConcreteHomePod()
        device._store = {'id': 'abc'}
        assert device._get_credentials() is None

    def test_returns_credential_string(self):
        device = ConcreteHomePod()
        device._store = {'credentials': 'cred-string-here'}
        assert device._get_credentials() == 'cred-string-here'


# ---------------------------------------------------------------------------
# _on_disconnected
# ---------------------------------------------------------------------------

class TestOnDisconnected:
    @pytest.mark.asyncio
    async def test_unexpected_false_does_nothing(self):
        device = ConcreteHomePod()
        device._disconnect = AsyncMock()
        device.find_service = AsyncMock()
        device._connect = AsyncMock()
        await device._on_disconnected(unexpected=False)
        device._disconnect.assert_not_called()
        device.find_service.assert_not_called()

    @pytest.mark.asyncio
    async def test_unexpected_true_calls_disconnect_before_reconnect(self):
        device = ConcreteHomePod()
        call_order = []
        device._disconnect = AsyncMock(side_effect=lambda: call_order.append('disconnect'))
        device.find_service = AsyncMock(side_effect=lambda *a: call_order.append('find'))
        device._connect = AsyncMock(side_effect=lambda: call_order.append('connect'))

        with patch('asyncio.sleep', new=AsyncMock()):
            await device._on_disconnected(unexpected=True)

        assert call_order == ['disconnect', 'find', 'connect']

    @pytest.mark.asyncio
    async def test_does_not_re_enter_when_already_reconnecting(self):
        device = ConcreteHomePod()
        device._is_reconnecting = True
        device._disconnect = AsyncMock()
        device.find_service = AsyncMock()
        device._connect = AsyncMock()
        await device._on_disconnected(unexpected=True)
        device._disconnect.assert_not_called()

    @pytest.mark.asyncio
    async def test_resets_is_reconnecting_on_completion(self):
        device = ConcreteHomePod()
        device._disconnect = AsyncMock()
        device.find_service = AsyncMock()
        device._connect = AsyncMock()

        with patch('asyncio.sleep', new=AsyncMock()):
            await device._on_disconnected(unexpected=True)

        assert device._is_reconnecting is False

    @pytest.mark.asyncio
    async def test_resets_is_reconnecting_even_on_error(self):
        device = ConcreteHomePod()
        device._disconnect = AsyncMock(side_effect=RuntimeError('boom'))
        device.find_service = AsyncMock()
        device._connect = AsyncMock()

        with patch('asyncio.sleep', new=AsyncMock()):
            with pytest.raises(RuntimeError):
                await device._on_disconnected(unexpected=True)

        assert device._is_reconnecting is False


# ---------------------------------------------------------------------------
# _disconnect
# ---------------------------------------------------------------------------

class TestDisconnect:
    @pytest.mark.asyncio
    async def test_stops_airplay_logic(self, mock_atv):
        device = ConcreteHomePod()
        device._atv = mock_atv
        await device._disconnect()
        device._airplay_logic.stop.assert_called_once()

    @pytest.mark.asyncio
    async def test_closes_atv_connection(self, mock_atv):
        device = ConcreteHomePod()
        device._atv = mock_atv
        await device._disconnect()
        mock_atv.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_sets_atv_to_none(self, mock_atv):
        device = ConcreteHomePod()
        device._atv = mock_atv
        await device._disconnect()
        assert device._atv is None

    @pytest.mark.asyncio
    async def test_safe_when_already_disconnected(self):
        device = ConcreteHomePod()
        device._atv = None
        await device._disconnect()  # must not raise
