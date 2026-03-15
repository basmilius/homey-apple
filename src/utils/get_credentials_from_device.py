from __future__ import annotations

from typing import Any


def get_credentials_from_device(device: Any) -> dict[str, str | None]:
    """
    Get pyatv credentials from the device store.

    Returns a dict with ``'airplay'`` and ``'companion'`` keys, each
    containing a credential string or *None*.

    The same credentials work for both AirPlay and Companion protocols.
    When only AirPlay credentials are present (the common case), they
    are returned for both keys.

    Supports both the new pyatv credential format (stored as a plain string)
    and the legacy TypeScript credential format (stored as a dict), converting
    the latter on the fly so that previously-paired devices continue to work.
    """
    store = device.get_store()

    airplay_credentials: str | None = None

    # New format: credential string stored directly by pyatv after pairing.
    raw = store.get('airplay_credentials')
    if isinstance(raw, str) and raw:
        airplay_credentials = raw
    else:
        # Legacy format: credentials stored by the old TypeScript library as a dict.
        old_credentials = store.get('credentials')
        if old_credentials and isinstance(old_credentials, dict):
            try:
                ltpk = old_credentials['accessoryLongTermPublicKey']
                ltsk = old_credentials['secretKey']
                atv_id_str = old_credentials['accessoryIdentifier']
                client_id = old_credentials['pairingId']

                # atv_id was stored as a hex string, possibly with colon separators
                # (e.g. "AA:BB:CC:DD:EE:FF"). Normalize to a plain lowercase hex string.
                atv_id = atv_id_str.lower().replace(':', '')

                airplay_credentials = f'{ltpk}:{ltsk}:{atv_id}:{client_id}'
            except (KeyError, TypeError) as err:
                device.error('Failed to convert legacy credentials:', err)

    # Companion credentials: use dedicated store value if present,
    # otherwise fall back to AirPlay credentials (they are interchangeable).
    companion_credentials = store.get('companion_credentials')
    if not companion_credentials or not isinstance(companion_credentials, str):
        companion_credentials = airplay_credentials

    return {
        'airplay': airplay_credentials,
        'companion': companion_credentials,
    }
