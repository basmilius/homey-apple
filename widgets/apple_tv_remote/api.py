from __future__ import annotations

from typing import Any

DRIVER_ID = 'apple-tv'


def _find_device(homey: Any, device_id: str) -> Any | None:
    """Find an Apple TV device by ID."""
    try:
        driver = homey.drivers.get_driver(DRIVER_ID)
        return driver.get_device_by_id(device_id)
    except Exception:
        return None


def _build_state(device: Any) -> dict:
    """Build the now playing state dict from a device's current capability values."""
    def cap(name: str) -> Any:
        try:
            return device.get_capability_value(name)
        except Exception:
            return None

    return {
        'deviceId': device._id,
        'deviceName': device.get_name(),
        'track': cap('speaker_track'),
        'artist': cap('speaker_artist'),
        'album': cap('speaker_album'),
        'playing': cap('speaker_playing'),
        'artworkUrl': cap('artwork_url'),
        'onoff': cap('onoff'),
    }


async def _send(homey: Any, query: dict | None, capability_id: str, value: Any = True) -> bool:
    """Find the Apple TV device from query and send a capability value."""
    device_id = (query or {}).get('deviceId')
    if not device_id:
        return False

    device = _find_device(homey, device_id)
    if device is None:
        return False

    try:
        await device.trigger_capability_listener(capability_id, value)
        return True
    except Exception:
        return False


async def get(homey: Any, query: dict | None = None, **kwargs: Any) -> dict | None:
    """Return the current now playing state for the selected Apple TV."""
    device_id = (query or {}).get('deviceId')
    if not device_id:
        return None

    device = _find_device(homey, device_id)
    if device is None:
        return None

    return _build_state(device)


async def remote_up(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Send D-pad Up."""
    return await _send(homey, query, 'remote_up')


async def remote_down(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Send D-pad Down."""
    return await _send(homey, query, 'remote_down')


async def remote_left(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Send D-pad Left."""
    return await _send(homey, query, 'remote_left')


async def remote_right(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Send D-pad Right."""
    return await _send(homey, query, 'remote_right')


async def remote_select(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Send D-pad Select/OK."""
    return await _send(homey, query, 'remote_select')


async def remote_home(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Send Home button."""
    return await _send(homey, query, 'remote_home')


async def remote_back(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Send Back/Menu button."""
    return await _send(homey, query, 'remote_back')


async def remote_playpause(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Send Play/Pause button."""
    return await _send(homey, query, 'remote_playpause')


async def remote_previous(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Skip to previous track."""
    return await _send(homey, query, 'speaker_prev')


async def remote_next(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Skip to next track."""
    return await _send(homey, query, 'speaker_next')


async def volume_up(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Increase volume."""
    return await _send(homey, query, 'volume_up')


async def volume_down(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Decrease volume."""
    return await _send(homey, query, 'volume_down')


async def mute(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Toggle mute."""
    device_id = (query or {}).get('deviceId')
    if not device_id:
        return False

    device = _find_device(homey, device_id)
    if device is None:
        return False

    try:
        current = device.get_capability_value('volume_mute')
        await device.trigger_capability_listener('volume_mute', not bool(current))
        return True
    except Exception:
        return False


async def power(homey: Any, query: dict | None = None, **kwargs: Any) -> bool:
    """Toggle power on the selected Apple TV."""
    device_id = (query or {}).get('deviceId')
    if not device_id:
        return False

    device = _find_device(homey, device_id)
    if device is None:
        return False

    try:
        current = device.get_capability_value('onoff')
        await device.trigger_capability_listener('onoff', not bool(current))
        return True
    except Exception:
        return False
