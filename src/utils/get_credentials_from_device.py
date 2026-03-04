from __future__ import annotations

import binascii
from typing import Any


def get_credentials_from_device(device: Any) -> str | None:
    """
    Get pyatv AirPlay HAP credentials from the device store.

    Supports both the new pyatv credential format (stored as a plain string)
    and the legacy TypeScript credential format (stored as a dict), converting
    the latter on the fly so that previously-paired devices continue to work.

    Returns a credential string in the pyatv HAP format
    ``ltpk_hex:ltsk_hex:atv_id_hex:client_id_hex``, or *None* when no
    credentials are found.
    """
    store = device.get_store()

    # New format: credential string stored directly by pyatv after pairing
    airplay_credentials = store.get('airplay_credentials')
    if airplay_credentials and isinstance(airplay_credentials, str):
        return airplay_credentials

    # Legacy format: credentials stored by the old TypeScript library as a dict
    old_credentials = store.get('credentials')
    if old_credentials and isinstance(old_credentials, dict):
        try:
            ltpk = old_credentials['accessoryLongTermPublicKey']
            ltsk = old_credentials['secretKey']
            atv_id_str = old_credentials['accessoryIdentifier']
            client_id = old_credentials['pairingId']

            # atv_id was stored as a plain string (e.g. "AA:BB:CC:DD:EE:FF");
            # encode it to bytes and then hex-encode for pyatv compatibility.
            atv_id = binascii.hexlify(atv_id_str.encode('utf-8')).decode('utf-8')

            return f'{ltpk}:{ltsk}:{atv_id}:{client_id}'
        except (KeyError, TypeError):
            return None

    return None
