"""Tests for lib/airplay_logic.py"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pyatv.const import DeviceState, MediaType, PowerState

# conftest patches sys.modules['homey'] before this import
from lib.airplay_logic import AirPlayLogic


@pytest.fixture
def logic(mock_device):
    return AirPlayLogic(mock_device)


# ---------------------------------------------------------------------------
# set_protocol / stop
# ---------------------------------------------------------------------------

class TestSetProtocol:
    def test_registers_push_listener(self, logic, mock_atv):
        logic.set_protocol(mock_atv)
        assert mock_atv.push_updater.listener is logic

    def test_starts_push_updater(self, logic, mock_atv):
        logic.set_protocol(mock_atv)
        mock_atv.push_updater.start.assert_called_once_with(initial_delay=0)

    def test_registers_power_listener(self, logic, mock_atv):
        logic.set_protocol(mock_atv)
        assert mock_atv.power.listener is logic


class TestStop:
    def test_stops_push_updater(self, logic, mock_atv):
        logic.set_protocol(mock_atv)
        logic.stop()
        mock_atv.push_updater.stop.assert_called_once()

    def test_clears_power_listener(self, logic, mock_atv):
        logic.set_protocol(mock_atv)
        logic.stop()
        assert mock_atv.power.listener is None

    def test_stop_without_atv_does_not_raise(self, logic):
        logic.stop()  # _atv is None — should be silent


# ---------------------------------------------------------------------------
# _handle_playstatus
# ---------------------------------------------------------------------------

def _make_playing(
    device_state=DeviceState.Playing,
    title='Track',
    artist='Artist',
    album='Album',
    total_time=240,
    position=30,
    volume=50.0,
    media_type=MediaType.Music,
    genre=None,
    app_id='com.example',
    app='Example',
    artwork_url=None,
):
    playing = MagicMock()
    playing.device_state = device_state
    playing.title = title
    playing.artist = artist
    playing.album = album
    playing.total_time = total_time
    playing.position = position
    playing.volume = volume
    playing.media_type = media_type
    playing.genre = genre
    playing.app_id = app_id
    playing.app = app
    playing.artwork_url = artwork_url
    return playing


class TestHandlePlaystatus:
    @pytest.mark.asyncio
    async def test_sets_speaker_playing_true_when_playing(self, logic, mock_device):
        playing = _make_playing(device_state=DeviceState.Playing)
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('speaker_playing', True)

    @pytest.mark.asyncio
    async def test_sets_speaker_playing_false_when_paused(self, logic, mock_device):
        playing = _make_playing(device_state=DeviceState.Paused)
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('speaker_playing', False)

    @pytest.mark.asyncio
    async def test_sets_track_artist_album(self, logic, mock_device):
        playing = _make_playing(title='Song', artist='Band', album='Record')
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('speaker_track', 'Song')
        mock_device.set_capability_value.assert_any_call('speaker_artist', 'Band')
        mock_device.set_capability_value.assert_any_call('speaker_album', 'Record')

    @pytest.mark.asyncio
    async def test_sets_duration_and_position(self, logic, mock_device):
        playing = _make_playing(total_time=300, position=60)
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('speaker_duration', 300)
        mock_device.set_capability_value.assert_any_call('speaker_position', 60)

    @pytest.mark.asyncio
    async def test_skips_duration_when_none(self, logic, mock_device):
        playing = _make_playing(total_time=None)
        await logic._handle_playstatus(playing)
        calls = [c.args[0] for c in mock_device.set_capability_value.call_args_list]
        assert 'speaker_duration' not in calls

    @pytest.mark.asyncio
    async def test_volume_scaled_to_homey_range(self, logic, mock_device):
        """pyatv volume is 0–100; Homey volume_set expects 0.0–1.0."""
        playing = _make_playing(volume=75.0)
        mock_device.has_capability.return_value = True
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('volume_set', 0.75)

    @pytest.mark.asyncio
    async def test_skips_volume_when_capability_absent(self, logic, mock_device):
        playing = _make_playing(volume=50.0)
        mock_device.has_capability.side_effect = lambda cap: cap != 'volume_set'
        await logic._handle_playstatus(playing)
        calls = [c.args[0] for c in mock_device.set_capability_value.call_args_list]
        assert 'volume_set' not in calls

    @pytest.mark.asyncio
    async def test_skips_if_device_off(self, logic, mock_device):
        playing = _make_playing()
        mock_device.has_capability.return_value = True
        mock_device.get_capability_value.side_effect = lambda cap: (
            False if cap == 'onoff' else None
        )
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_not_called()

    @pytest.mark.asyncio
    async def test_proceeds_when_no_onoff_capability(self, logic, mock_device):
        playing = _make_playing()
        mock_device.has_capability.side_effect = lambda cap: cap != 'onoff'
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('speaker_playing', True)

    # Media type mapping
    @pytest.mark.asyncio
    async def test_media_type_music(self, logic, mock_device):
        playing = _make_playing(media_type=MediaType.Music, genre=None)
        mock_device.has_capability.return_value = True
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('media_type', 'music')

    @pytest.mark.asyncio
    async def test_media_type_video(self, logic, mock_device):
        playing = _make_playing(media_type=MediaType.Video, genre=None)
        mock_device.has_capability.return_value = True
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('media_type', 'video')

    @pytest.mark.asyncio
    async def test_media_type_tv_maps_to_video(self, logic, mock_device):
        playing = _make_playing(media_type=MediaType.TV, genre=None)
        mock_device.has_capability.return_value = True
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('media_type', 'video')

    @pytest.mark.asyncio
    async def test_media_type_podcast_via_genre(self, logic, mock_device):
        playing = _make_playing(media_type=MediaType.Music, genre='Podcasts')
        mock_device.has_capability.return_value = True
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('media_type', 'podcast')

    @pytest.mark.asyncio
    async def test_media_type_audiobook_via_genre(self, logic, mock_device):
        playing = _make_playing(media_type=MediaType.Music, genre='Audiobook')
        mock_device.has_capability.return_value = True
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('media_type', 'audiobook')

    @pytest.mark.asyncio
    async def test_empty_strings_for_none_metadata(self, logic, mock_device):
        playing = _make_playing(title=None, artist=None, album=None)
        await logic._handle_playstatus(playing)
        mock_device.set_capability_value.assert_any_call('speaker_track', '')
        mock_device.set_capability_value.assert_any_call('speaker_artist', '')
        mock_device.set_capability_value.assert_any_call('speaker_album', '')


# ---------------------------------------------------------------------------
# _handle_powerstate
# ---------------------------------------------------------------------------

class TestHandlePowerstate:
    @pytest.mark.asyncio
    async def test_power_on_sets_onoff_true(self, logic, mock_device):
        mock_device.has_capability.return_value = False
        await logic._handle_powerstate(PowerState.On)
        mock_device.set_capability_value.assert_any_call('onoff', True)

    @pytest.mark.asyncio
    async def test_power_off_sets_onoff_false(self, logic, mock_device):
        mock_device.has_capability.return_value = False
        await logic._handle_powerstate(PowerState.Off)
        mock_device.set_capability_value.assert_any_call('onoff', False)

    @pytest.mark.asyncio
    async def test_power_off_clears_now_playing(self, logic, mock_device):
        mock_device.has_capability.return_value = False
        logic.clear_now_playing = AsyncMock()
        await logic._handle_powerstate(PowerState.Off)
        logic.clear_now_playing.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_power_on_does_not_clear_now_playing(self, logic, mock_device):
        mock_device.has_capability.return_value = False
        logic.clear_now_playing = AsyncMock()
        await logic._handle_powerstate(PowerState.On)
        logic.clear_now_playing.assert_not_called()

    @pytest.mark.asyncio
    async def test_sets_power_capability_when_present(self, logic, mock_device):
        mock_device.has_capability.side_effect = lambda cap: cap == 'power'
        mock_device.homey.__ = lambda key: key
        await logic._handle_powerstate(PowerState.On)
        calls = {c.args[0] for c in mock_device.set_capability_value.call_args_list}
        assert 'power' in calls


# ---------------------------------------------------------------------------
# clear_now_playing
# ---------------------------------------------------------------------------

class TestClearNowPlaying:
    @pytest.mark.asyncio
    async def test_resets_all_now_playing_capabilities(self, logic, mock_device):
        await logic.clear_now_playing()
        mock_device.set_capability_value.assert_any_call('speaker_album', '')
        mock_device.set_capability_value.assert_any_call('speaker_artist', '')
        mock_device.set_capability_value.assert_any_call('speaker_track', '')
        mock_device.set_capability_value.assert_any_call('speaker_duration', -1)
        mock_device.set_capability_value.assert_any_call('speaker_position', -1)
        mock_device.set_capability_value.assert_any_call('speaker_playing', False)

    @pytest.mark.asyncio
    async def test_resets_artwork_identifier(self, logic, mock_device):
        logic._artwork_identifier = 'http://example.com/art.jpg'
        await logic.clear_now_playing()
        assert logic._artwork_identifier is None


# ---------------------------------------------------------------------------
# _update_artwork
# ---------------------------------------------------------------------------

class TestUpdateArtwork:
    @pytest.mark.asyncio
    async def test_skips_duplicate_url(self, logic, mock_device):
        url = 'http://example.com/art.jpg'
        logic._artwork_identifier = url
        mock_device.homey.images = MagicMock()
        await logic._update_artwork(url)
        mock_device.homey.images.create_image.assert_not_called()

    @pytest.mark.asyncio
    async def test_replaces_heic_with_jpg(self, logic, mock_device):
        captured_url = []

        async def fake_create():
            img = MagicMock()
            img.set_url = MagicMock(side_effect=lambda u: captured_url.append(u))
            img.update = AsyncMock()
            img.cloud_url = None
            return img

        mock_device.homey.images.create_image = AsyncMock(side_effect=fake_create)
        mock_device.has_capability.return_value = False

        await logic._update_artwork('http://example.com/art.heic')
        assert captured_url and captured_url[0].endswith('.jpg')

    @pytest.mark.asyncio
    async def test_updates_artwork_identifier(self, logic, mock_device):
        url = 'http://example.com/art.jpg'
        logic._artwork_identifier = None

        async def fake_create():
            img = MagicMock()
            img.set_url = MagicMock()
            img.update = AsyncMock()
            img.cloud_url = None
            return img

        mock_device.homey.images.create_image = AsyncMock(side_effect=fake_create)
        mock_device.has_capability.return_value = False

        await logic._update_artwork(url)
        assert logic._artwork_identifier == url
