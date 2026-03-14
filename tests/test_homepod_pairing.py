"""Tests for lib/homepod_pairing.py"""
from __future__ import annotations

import re
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from lib.homepod_pairing import HomePodBasePairing


HOMEPOD_PATTERN = re.compile(r'AudioAccessory[16],\d+')
HOMEPOD_MINI_PATTERN = re.compile(r'AudioAccessory5,\d+')


def _make_session():
    session = MagicMock()
    session.set_handler = MagicMock()
    session.show_view = AsyncMock()
    return session


class _FakeDevice:
    """Plain object so getattr(dev, '_credentials', None) correctly returns None before pairing."""
    def __init__(self, identifier='hp-id', name='HomePod', model='AudioAccessory1,1'):
        self.identifier = identifier
        self.name = name
        self.properties = {'model': model}

    def get_data(self):
        return {'id': self.identifier}


def _make_device(identifier='hp-id', name='HomePod', model='AudioAccessory1,1'):
    return _FakeDevice(identifier=identifier, name=name, model=model)


def _make_instance(model_filter=HOMEPOD_PATTERN, known_devices=None):
    session = _make_session()
    homey = MagicMock()
    instance = HomePodBasePairing(session, model_filter, known_devices or [], homey)
    return instance, session


# ---------------------------------------------------------------------------
# _on_get_device
# ---------------------------------------------------------------------------

class TestOnGetDevice:
    @pytest.mark.asyncio
    async def test_returns_none_when_no_device(self):
        instance, _ = _make_instance()
        assert await instance._on_get_device() is None

    @pytest.mark.asyncio
    async def test_returns_name_and_data(self):
        instance, _ = _make_instance()
        device = _make_device(identifier='hp-abc', name='HomePod Living Room')
        instance._selected_device = device

        result = await instance._on_get_device()

        assert result['name'] == 'HomePod Living Room'
        assert result['data']['id'] == 'hp-abc'

    @pytest.mark.asyncio
    async def test_returns_store_with_credentials(self):
        """store must contain credentials so they survive Homey restarts."""
        instance, _ = _make_instance()
        device = _make_device(identifier='hp-abc')
        device._credentials = 'homepod-airplay-creds'
        instance._selected_device = device

        result = await instance._on_get_device()

        assert result['store']['credentials'] == 'homepod-airplay-creds'
        assert result['store']['id'] == 'hp-abc'

    @pytest.mark.asyncio
    async def test_store_credentials_none_before_pairing(self):
        instance, _ = _make_instance()
        device = _make_device()
        instance._selected_device = device

        result = await instance._on_get_device()

        assert result['store']['credentials'] is None


# ---------------------------------------------------------------------------
# _on_list_devices
# ---------------------------------------------------------------------------

class TestOnListDevices:
    @pytest.mark.asyncio
    async def test_filters_by_model_pattern(self):
        instance, _ = _make_instance(model_filter=HOMEPOD_PATTERN)
        hp = _make_device(identifier='1', model='AudioAccessory1,1')
        atv = _make_device(identifier='2', model='AppleTV6,2')
        instance._devices = [hp, atv]

        result = await instance._on_list_devices()

        assert hp in result
        assert atv not in result

    @pytest.mark.asyncio
    async def test_mini_filter_excludes_full_homepod(self):
        instance, _ = _make_instance(model_filter=HOMEPOD_MINI_PATTERN)
        mini = _make_device(identifier='1', model='AudioAccessory5,1')
        full = _make_device(identifier='2', model='AudioAccessory1,1')
        instance._devices = [mini, full]

        result = await instance._on_list_devices()

        assert mini in result
        assert full not in result

    @pytest.mark.asyncio
    async def test_excludes_known_devices(self):
        known = MagicMock()
        known.get_data = MagicMock(return_value={'id': 'known-hp'})
        instance, _ = _make_instance(known_devices=[known])

        new_hp = _make_device(identifier='new-hp', model='AudioAccessory1,1')
        old_hp = _make_device(identifier='known-hp', model='AudioAccessory1,1')
        instance._devices = [new_hp, old_hp]

        result = await instance._on_list_devices()

        assert new_hp in result
        assert old_hp not in result


# ---------------------------------------------------------------------------
# _on_show_view_authenticate — transient pairing (no PIN)
# ---------------------------------------------------------------------------

class TestOnShowViewAuthenticate:
    @pytest.mark.asyncio
    async def test_shows_add_my_device_on_success(self):
        instance, session = _make_instance()
        device = _make_device()
        instance._selected_device = device

        mock_pairing = MagicMock()
        mock_pairing.begin = AsyncMock()
        mock_pairing.finish = AsyncMock()
        mock_pairing.close = AsyncMock()
        mock_pairing.has_paired = True
        mock_pairing.service = MagicMock()
        mock_pairing.service.credentials = 'hp-creds'

        with patch('lib.homepod_pairing.pyatv.pair', new=AsyncMock(return_value=mock_pairing)):
            await instance._on_show_view_authenticate()

        session.show_view.assert_awaited_once_with('add_my_device')

    @pytest.mark.asyncio
    async def test_stores_credentials_on_success(self):
        instance, _ = _make_instance()
        device = _make_device()
        instance._selected_device = device

        mock_pairing = MagicMock()
        mock_pairing.begin = AsyncMock()
        mock_pairing.finish = AsyncMock()
        mock_pairing.close = AsyncMock()
        mock_pairing.has_paired = True
        mock_pairing.service = MagicMock()
        mock_pairing.service.credentials = 'hp-creds-xyz'

        with patch('lib.homepod_pairing.pyatv.pair', new=AsyncMock(return_value=mock_pairing)):
            await instance._on_show_view_authenticate()

        assert device._credentials == 'hp-creds-xyz'

    @pytest.mark.asyncio
    async def test_redirects_to_list_devices_without_selection(self):
        instance, session = _make_instance()
        instance._selected_device = None
        await instance._on_show_view_authenticate()
        session.show_view.assert_awaited_once_with('list_devices')

    @pytest.mark.asyncio
    async def test_always_closes_pairing_even_on_failure(self):
        instance, _ = _make_instance()
        device = _make_device()
        instance._selected_device = device

        mock_pairing = MagicMock()
        mock_pairing.begin = AsyncMock()
        mock_pairing.finish = AsyncMock(side_effect=RuntimeError('network error'))
        mock_pairing.close = AsyncMock()

        with patch('lib.homepod_pairing.pyatv.pair', new=AsyncMock(return_value=mock_pairing)):
            with pytest.raises(RuntimeError):
                await instance._on_show_view_authenticate()

        mock_pairing.close.assert_awaited_once()


# ---------------------------------------------------------------------------
# _on_list_devices_selection
# ---------------------------------------------------------------------------

class TestOnListDevicesSelection:
    @pytest.mark.asyncio
    async def test_picks_last_device(self):
        instance, _ = _make_instance()
        d1 = _make_device(identifier='a')
        d2 = _make_device(identifier='b')
        await instance._on_list_devices_selection([d1, d2])
        assert instance._selected_device is d2

    @pytest.mark.asyncio
    async def test_empty_list_does_not_change_selection(self):
        instance, _ = _make_instance()
        original = _make_device()
        instance._selected_device = original
        await instance._on_list_devices_selection([])
        assert instance._selected_device is original
