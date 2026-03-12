"""Shared fixtures and homey SDK stub for all tests.

The `homey` module is injected by the Homey runtime at deploy time and is
not on PyPI, so we create a minimal in-process stub before any app imports.
"""
from __future__ import annotations

import asyncio
import sys
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock

import pytest


# ---------------------------------------------------------------------------
# Minimal homey SDK stub
# ---------------------------------------------------------------------------

class _HomeyDevice:
    """Stub for homey.Device — all SDK methods are no-ops by default."""

    def __init__(self):
        self.homey = MagicMock()
        self.homey.__ = lambda key: key  # i18n stub

    async def on_init(self):
        pass

    async def set_unavailable(self, msg: str = ''):
        pass

    async def set_available(self):
        pass

    async def set_capability_value(self, cap: str, value):
        pass

    def get_capability_value(self, cap: str):
        return None

    def has_capability(self, cap: str) -> bool:
        return True

    def get_capabilities(self) -> list:
        return []

    async def remove_capability(self, cap: str):
        pass

    def get_data(self) -> dict:
        return {}

    def get_store(self) -> dict:
        return {}

    def register_capability_listener(self, cap: str, fn):
        pass

    def register_multiple_capability_listener(self, caps, fn, delay=0):
        pass

    async def set_album_art_image(self, image):
        pass

    def log(self, *args):
        pass

    def error(self, *args):
        pass


class _HomeyApp:
    def __init__(self):
        self.homey = MagicMock()

    async def on_init(self):
        pass

    def log(self, *args):
        pass

    def error(self, *args):
        pass


class _HomeyModule(ModuleType):
    Device = _HomeyDevice
    App = _HomeyApp


# Inject the stub before any app-level imports happen.
sys.modules.setdefault('homey', _HomeyModule('homey'))


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def event_loop():
    """Provide a fresh event loop for each test."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def mock_device():
    """A MagicMock that looks like a homey.Device for passing to AirPlayLogic."""
    device = MagicMock(spec=_HomeyDevice)
    device.set_capability_value = AsyncMock()
    device.set_unavailable = AsyncMock()
    device.set_available = AsyncMock()
    device.remove_capability = AsyncMock()
    device.set_album_art_image = AsyncMock()
    device.has_capability = MagicMock(return_value=True)
    # By default the device is "on" (onoff=True); tests that need offline behaviour
    # override this with an explicit side_effect.
    device.get_capability_value = MagicMock(
        side_effect=lambda cap: True if cap == 'onoff' else None
    )
    device.get_capabilities = MagicMock(return_value=[])
    device.get_data = MagicMock(return_value={'id': 'test-device-id'})
    device.get_store = MagicMock(return_value={})
    device.homey = MagicMock()
    device.homey.__ = lambda key: key
    device.trigger_now_playing_app_changed = AsyncMock()
    device.trigger_artwork_url_updated = AsyncMock()
    return device


@pytest.fixture
def mock_atv():
    """A MagicMock that looks like a pyatv AppleTV connection."""
    atv = MagicMock()
    atv.push_updater = MagicMock()
    atv.push_updater.listener = None
    atv.push_updater.start = MagicMock()
    atv.push_updater.stop = MagicMock()
    atv.power = MagicMock()
    atv.power.listener = None
    atv.power.turn_on = AsyncMock()
    atv.power.turn_off = AsyncMock()
    atv.remote_control = MagicMock()
    atv.remote_control.next = AsyncMock()
    atv.remote_control.previous = AsyncMock()
    atv.remote_control.play = AsyncMock()
    atv.remote_control.pause = AsyncMock()
    atv.remote_control.stop = AsyncMock()
    atv.remote_control.play_pause = AsyncMock()
    atv.remote_control.up = AsyncMock()
    atv.remote_control.down = AsyncMock()
    atv.remote_control.left = AsyncMock()
    atv.remote_control.right = AsyncMock()
    atv.remote_control.select = AsyncMock()
    atv.remote_control.home = AsyncMock()
    atv.remote_control.menu = AsyncMock()
    atv.remote_control.set_position = AsyncMock()
    atv.remote_control.skip_forward = AsyncMock()
    atv.remote_control.skip_backward = AsyncMock()
    atv.audio = MagicMock()
    atv.audio.volume_up = AsyncMock()
    atv.audio.volume_down = AsyncMock()
    atv.audio.set_volume = AsyncMock()
    atv.stream = MagicMock()
    atv.stream.play_url = AsyncMock()
    atv.close = AsyncMock()
    return atv
