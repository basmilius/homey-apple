"""Tests for lib/apple_tv_pairing.py"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from lib.apple_tv_pairing import AppleTVPairing


def _make_pairing(has_paired=True, credentials='cred-abc'):
    pairing = MagicMock()
    pairing.has_paired = has_paired
    pairing.pin = MagicMock()  # synchronous
    pairing.finish = AsyncMock()
    pairing.begin = AsyncMock()
    pairing.close = AsyncMock()
    pairing.service = MagicMock()
    pairing.service.credentials = credentials
    return pairing


def _make_session():
    session = MagicMock()
    session.set_handler = MagicMock()
    session.show_view = AsyncMock()
    return session


class _FakeDevice:
    """Plain object so getattr(dev, '_credentials', None) correctly returns None before pairing."""
    def __init__(self, identifier='dev-id', name='Apple TV', model='AppleTV6,2'):
        self.identifier = identifier
        self.name = name
        self.properties = {'model': model}

    def get_data(self):
        return {'id': self.identifier}


def _make_device(identifier='dev-id', name='Apple TV', model='AppleTV6,2'):
    return _FakeDevice(identifier=identifier, name=name, model=model)


def _make_instance(known_devices=None):
    session = _make_session()
    homey = MagicMock()
    instance = AppleTVPairing(session, known_devices or [], homey)
    return instance, session


# ---------------------------------------------------------------------------
# _on_pincode — correct PIN
# ---------------------------------------------------------------------------

class TestOnPincode:
    @pytest.mark.asyncio
    async def test_correct_pin_stores_credentials(self):
        instance, session = _make_instance()
        device = _make_device()
        instance._selected_device = device
        pairing = _make_pairing(has_paired=True, credentials='my-creds')
        instance._pairing = pairing

        await instance._on_pincode('1234')

        assert device._credentials == 'my-creds'

    @pytest.mark.asyncio
    async def test_correct_pin_shows_add_my_device(self):
        instance, session = _make_instance()
        instance._selected_device = _make_device()
        instance._pairing = _make_pairing(has_paired=True)

        await instance._on_pincode('1234')

        session.show_view.assert_awaited_once_with('add_my_device')

    @pytest.mark.asyncio
    async def test_correct_pin_clears_pairing_object(self):
        instance, session = _make_instance()
        instance._selected_device = _make_device()
        instance._pairing = _make_pairing(has_paired=True)

        await instance._on_pincode('1234')

        assert instance._pairing is None

    @pytest.mark.asyncio
    async def test_wrong_pin_shows_authenticate_view(self):
        """Failed pairing must send user back to authenticate so they can retry."""
        instance, session = _make_instance()
        instance._selected_device = _make_device()
        instance._pairing = _make_pairing(has_paired=False)

        await instance._on_pincode('0000')

        session.show_view.assert_awaited_once_with('authenticate')

    @pytest.mark.asyncio
    async def test_wrong_pin_clears_pairing_object(self):
        instance, session = _make_instance()
        instance._selected_device = _make_device()
        instance._pairing = _make_pairing(has_paired=False)

        await instance._on_pincode('0000')

        assert instance._pairing is None

    @pytest.mark.asyncio
    async def test_pin_accepted_as_list_of_ints(self):
        """Homey sometimes sends [1, 2, 3, 4] instead of '1234'."""
        instance, session = _make_instance()
        device = _make_device()
        instance._selected_device = device
        pairing = _make_pairing(has_paired=True, credentials='cred-x')
        instance._pairing = pairing

        await instance._on_pincode([1, 2, 3, 4])

        pairing.pin.assert_called_once_with('1234')

    @pytest.mark.asyncio
    async def test_pin_calls_pairing_pin_with_string(self):
        instance, session = _make_instance()
        instance._selected_device = _make_device()
        pairing = _make_pairing(has_paired=True)
        instance._pairing = pairing

        await instance._on_pincode('5678')

        pairing.pin.assert_called_once_with('5678')

    @pytest.mark.asyncio
    async def test_pin_finishes_pairing(self):
        instance, session = _make_instance()
        instance._selected_device = _make_device()
        pairing = _make_pairing(has_paired=True)
        instance._pairing = pairing

        await instance._on_pincode('1234')

        pairing.finish.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_pin_closes_pairing(self):
        instance, session = _make_instance()
        instance._selected_device = _make_device()
        pairing = _make_pairing(has_paired=True)
        instance._pairing = pairing

        await instance._on_pincode('1234')

        pairing.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_no_op_when_pairing_object_missing(self):
        """Should not crash if pairing is None (e.g. called out of order)."""
        instance, session = _make_instance()
        instance._pairing = None
        await instance._on_pincode('1234')  # must not raise
        session.show_view.assert_not_called()


# ---------------------------------------------------------------------------
# _on_get_device
# ---------------------------------------------------------------------------

class TestOnGetDevice:
    @pytest.mark.asyncio
    async def test_returns_none_when_no_device_selected(self):
        instance, _ = _make_instance()
        result = await instance._on_get_device()
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_dict_with_name_and_data(self):
        instance, _ = _make_instance()
        device = _make_device(identifier='abc123', name='Living Room Apple TV')
        instance._selected_device = device

        result = await instance._on_get_device()

        assert result['name'] == 'Living Room Apple TV'
        assert result['data']['id'] == 'abc123'

    @pytest.mark.asyncio
    async def test_returns_store_field_with_credentials(self):
        """store must contain credentials so Homey persists them across reboots."""
        instance, _ = _make_instance()
        device = _make_device(identifier='abc123')
        device._credentials = 'my-airplay-creds'
        instance._selected_device = device

        result = await instance._on_get_device()

        assert 'store' in result
        assert result['store']['credentials'] == 'my-airplay-creds'
        assert result['store']['id'] == 'abc123'

    @pytest.mark.asyncio
    async def test_store_credentials_none_when_not_paired(self):
        instance, _ = _make_instance()
        device = _make_device()
        # No _credentials attribute set
        instance._selected_device = device

        result = await instance._on_get_device()

        assert result['store']['credentials'] is None


# ---------------------------------------------------------------------------
# _on_list_devices
# ---------------------------------------------------------------------------

class TestOnListDevices:
    @pytest.mark.asyncio
    async def test_filters_out_known_devices(self):
        known = MagicMock()
        known.get_data = MagicMock(return_value={'id': 'known-id'})
        instance, _ = _make_instance(known_devices=[known])

        new_device = _make_device(identifier='new-id', model='AppleTV6,2')
        old_device = _make_device(identifier='known-id', model='AppleTV6,2')
        instance._devices = [new_device, old_device]

        result = await instance._on_list_devices()

        assert new_device in result
        assert old_device not in result

    @pytest.mark.asyncio
    async def test_filters_out_non_apple_tv_models(self):
        instance, _ = _make_instance()
        atv = _make_device(model='AppleTV6,2')
        homepod = _make_device(model='AudioAccessory1,1')
        instance._devices = [atv, homepod]

        result = await instance._on_list_devices()

        assert atv in result
        assert homepod not in result

    @pytest.mark.asyncio
    async def test_returns_sorted_by_name(self):
        instance, _ = _make_instance()
        d1 = _make_device(identifier='1', name='Zorro', model='AppleTV6,2')
        d2 = _make_device(identifier='2', name='Alpha', model='AppleTV11,1')
        instance._devices = [d1, d2]

        result = await instance._on_list_devices()

        assert result == [d2, d1]


# ---------------------------------------------------------------------------
# _on_list_devices_selection
# ---------------------------------------------------------------------------

class TestOnListDevicesSelection:
    @pytest.mark.asyncio
    async def test_selects_last_device(self):
        instance, _ = _make_instance()
        d1 = _make_device(identifier='a')
        d2 = _make_device(identifier='b')
        await instance._on_list_devices_selection([d1, d2])
        assert instance._selected_device is d2

    @pytest.mark.asyncio
    async def test_empty_list_leaves_selection_unchanged(self):
        instance, _ = _make_instance()
        original = _make_device()
        instance._selected_device = original
        await instance._on_list_devices_selection([])
        assert instance._selected_device is original
