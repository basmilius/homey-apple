from __future__ import annotations

from typing import Any

from pyatv.const import RepeatState, ShuffleState

DRIVER_IDS = ('apple-tv', 'homepod', 'homepod-mini')

_REPEAT_CYCLE: dict[str, RepeatState] = {
    'off': RepeatState.All,
    'all': RepeatState.Track,
    'one': RepeatState.Off,
}


def _find_device(homey: Any, device_id: str) -> Any | None:
    """Find a device by ID across all Apple TV and HomePod drivers."""
    for driver_id in DRIVER_IDS:
        try:
            driver = homey.drivers.get_driver(driver_id)
            device = driver.get_device_by_id(device_id)
            if device is not None:
                return device
        except Exception:
            continue

    return None


def _build_state(device: Any) -> dict:
    """Build the playback state dict from a device's current capability values."""
    def cap(name: str) -> Any:
        try:
            return device.get_capability_value(name)
        except Exception:
            return None

    logic = getattr(device, 'airplay_logic', None)

    return {
        'deviceId': device.get_id(),
        'deviceName': device.get_name(),
        'track': cap('speaker_track'),
        'artist': cap('speaker_artist'),
        'album': cap('speaker_album'),
        'playing': cap('speaker_playing'),
        'position': cap('speaker_position'),
        'duration': cap('speaker_duration'),
        'volume': cap('volume_set'),
        'artworkUrl': cap('artwork_url'),
        'onoff': cap('onoff'),
        'shuffle': getattr(logic, '_shuffle', False),
        'repeat': getattr(logic, '_repeat', 'off'),
        'positionTimestamp': int(getattr(logic, '_position_update_time', 0) * 1000),
        'features': logic.get_feature_availability() if logic is not None else {
            'previous': False, 'next': False, 'shuffle': False, 'repeat': False,
        },
    }


async def get(homey: Any, params: dict | None = None, **kwargs: Any) -> dict | None:
    """Return the current playback state for the selected device."""
    device_id = (params or {}).get('deviceId')
    if not device_id:
        return None

    device = _find_device(homey, device_id)
    if device is None:
        return None

    return _build_state(device)


async def set_playing(homey: Any, params: dict | None = None, **kwargs: Any) -> bool:
    """Toggle play/pause on the selected device."""
    device_id = (params or {}).get('deviceId')
    if not device_id:
        return False

    device = _find_device(homey, device_id)
    if device is None:
        return False

    try:
        current = device.get_capability_value('speaker_playing')
        await device.trigger_capability_listener('speaker_playing', not bool(current))
        return True
    except Exception:
        return False


async def set_next(homey: Any, params: dict | None = None, **kwargs: Any) -> bool:
    """Skip to the next track on the selected device."""
    device_id = (params or {}).get('deviceId')
    if not device_id:
        return False

    device = _find_device(homey, device_id)
    if device is None:
        return False

    try:
        await device.trigger_capability_listener('speaker_next', True)
        return True
    except Exception:
        return False


async def set_previous(homey: Any, params: dict | None = None, **kwargs: Any) -> bool:
    """Skip to the previous track on the selected device."""
    device_id = (params or {}).get('deviceId')
    if not device_id:
        return False

    device = _find_device(homey, device_id)
    if device is None:
        return False

    try:
        await device.trigger_capability_listener('speaker_prev', True)
        return True
    except Exception:
        return False


async def set_shuffle(homey: Any, params: dict | None = None, **kwargs: Any) -> bool:
    """Toggle shuffle on the selected device (Apple TV only)."""
    device_id = (params or {}).get('deviceId')
    if not device_id:
        return False

    device = _find_device(homey, device_id)
    if device is None:
        return False

    atv = getattr(device, 'atv', None)
    if atv is None:
        return False

    logic = getattr(device, 'airplay_logic', None)
    current_shuffle = getattr(logic, '_shuffle', False)
    new_state = ShuffleState.Off if current_shuffle else ShuffleState.Songs

    try:
        await atv.remote_control.set_shuffle(new_state)
    except Exception:
        return False

    return True


async def set_repeat(homey: Any, params: dict | None = None, **kwargs: Any) -> bool:
    """Cycle repeat mode on the selected device (Apple TV only): off → all → one → off."""
    device_id = (params or {}).get('deviceId')
    if not device_id:
        return False

    device = _find_device(homey, device_id)
    if device is None:
        return False

    atv = getattr(device, 'atv', None)
    if atv is None:
        return False

    logic = getattr(device, 'airplay_logic', None)
    current_repeat = getattr(logic, '_repeat', 'off')

    new_state = _REPEAT_CYCLE.get(current_repeat, RepeatState.Off)

    try:
        await atv.remote_control.set_repeat(new_state)
    except Exception:
        return False

    return True


async def set_volume(homey: Any, body: dict | None = None, params: dict | None = None, **kwargs: Any) -> bool:
    """Set the volume on the selected device (0.0–1.0)."""
    device_id = (params or {}).get('deviceId')
    volume = (body or {}).get('volume')
    if not device_id or volume is None:
        return False

    device = _find_device(homey, device_id)
    if device is None:
        return False

    if not getattr(device, 'has_capability', lambda _: False)('volume_set'):
        return False

    try:
        volume_value = float(volume)
    except (TypeError, ValueError):
        return False

    if not 0.0 <= volume_value <= 1.0:
        return False

    try:
        await device.trigger_capability_listener('volume_set', volume_value)
        return True
    except Exception:
        return False
