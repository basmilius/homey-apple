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


def _get_device(homey: Any, params: dict | None) -> Any | None:
    """Extract device_id from params and look up the device."""
    device_id = (params or {}).get('deviceId')
    if not device_id:
        return None
    return _find_device(homey, device_id)


def _build_state(device: Any) -> dict:
    """Build the playback state dict from a device's current capability values."""
    def cap(name: str) -> Any:
        try:
            return device.get_capability_value(name)
        except Exception:
            return None

    logic = device.airplay_logic

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
        'shuffle': logic.shuffle if logic is not None else False,
        'repeat': logic.repeat if logic is not None else 'off',
        'positionTimestamp': int(logic.position_update_time * 1000) if logic is not None else 0,
        'features': logic.get_feature_availability() if logic is not None else {
            'previous': False, 'next': False, 'shuffle': False, 'repeat': False,
        },
    }


async def get(homey: Any, params: dict | None = None, **kwargs: Any) -> dict | None:
    """Return the current playback state for the selected device."""
    device = _get_device(homey, params)
    if device is None:
        return None

    return _build_state(device)


async def set_playing(homey: Any, params: dict | None = None, **kwargs: Any) -> bool:
    """Toggle play/pause on the selected device."""
    device = _get_device(homey, params)
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
    device = _get_device(homey, params)
    if device is None:
        return False

    try:
        await device.trigger_capability_listener('speaker_next', True)
        return True
    except Exception:
        return False


async def set_previous(homey: Any, params: dict | None = None, **kwargs: Any) -> bool:
    """Skip to the previous track on the selected device."""
    device = _get_device(homey, params)
    if device is None:
        return False

    try:
        await device.trigger_capability_listener('speaker_prev', True)
        return True
    except Exception:
        return False


async def set_shuffle(homey: Any, params: dict | None = None, **kwargs: Any) -> bool:
    """Toggle shuffle on the selected device (Apple TV only)."""
    device = _get_device(homey, params)
    if device is None:
        return False

    if device.atv is None:
        return False

    current_shuffle = device.airplay_logic.shuffle if device.airplay_logic is not None else False
    new_state = ShuffleState.Off if current_shuffle else ShuffleState.Songs

    try:
        await device.atv.remote_control.set_shuffle(new_state)
    except Exception:
        return False

    return True


async def set_repeat(homey: Any, params: dict | None = None, **kwargs: Any) -> bool:
    """Cycle repeat mode on the selected device (Apple TV only): off → all → one → off."""
    device = _get_device(homey, params)
    if device is None:
        return False

    if device.atv is None:
        return False

    current_repeat = device.airplay_logic.repeat if device.airplay_logic is not None else 'off'

    new_state = _REPEAT_CYCLE.get(current_repeat, RepeatState.Off)

    try:
        await device.atv.remote_control.set_repeat(new_state)
    except Exception:
        return False

    return True


async def set_volume(homey: Any, body: dict | None = None, params: dict | None = None, **kwargs: Any) -> bool:
    """Set the volume on the selected device (0.0–1.0)."""
    volume = (body or {}).get('volume')
    device = _get_device(homey, params)
    if device is None or volume is None:
        return False

    if not device.has_capability('volume_set'):
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
