from __future__ import annotations

import re

_MAC_COLON_RE = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
_MAC_PLAIN_RE = re.compile(r"^[0-9A-Fa-f]{12}$")


def extract_mac_from_txt(txt: dict[str, str]) -> str | None:
    """
    Extract a MAC address from mDNS TXT record values.

    Checks multiple fields in priority order:

    1. ``deviceid`` — AirPlay TXT record (already in MAC format)
    2. ``psi`` — AirPlay fallback (already in MAC format)
    3. ``rpmrtid`` — Companion TXT record (UUID-like, first 12 hex chars → MAC)
    4. RAOP name prefix — first 12 hex chars of the service name

    Returns the MAC address normalized to uppercase colon-separated
    format, or ``None``.
    """
    # Direct MAC fields (AirPlay).
    for key in ("deviceid", "psi"):
        value = txt.get(key)
        if value and is_mac_format(value):
            return _normalize_mac(value)

    # Companion: rpmrtid is a UUID-like string, first 12 hex chars map to MAC.
    rpmrtid = txt.get("rpmrtid")
    if rpmrtid:
        mac = _mac_from_uuid_like(rpmrtid)
        if mac:
            return mac

    return None


def extract_mac_from_name(name: str | None) -> str | None:
    """
    Extract a MAC address from a RAOP service name.

    RAOP service names are prefixed with 12 hex characters representing
    the MAC address (e.g. ``AABBCCDDEEFF@Living Room``).
    """
    if not name:
        return None

    prefix = name.split("@")[0] if "@" in name else name[:12]
    if _MAC_PLAIN_RE.match(prefix):
        return _normalize_mac(prefix)

    return None


def is_mac_format(value: str) -> bool:
    """Return True if *value* looks like a MAC address."""
    return bool(_MAC_COLON_RE.match(value) or _MAC_PLAIN_RE.match(value))


def _normalize_mac(value: str) -> str:
    """Normalize a MAC address to uppercase colon-separated format."""
    plain = value.replace(":", "").upper()
    return ":".join(plain[i:i + 2] for i in range(0, 12, 2))


def _mac_from_uuid_like(value: str) -> str | None:
    """
    Extract a MAC from a UUID-like identifier.

    Takes the first 8 chars + chars 9-13 (skipping the hyphen at position 8)
    to form 12 hex chars, then converts to MAC format.
    """
    hex_chars = value.replace("-", "").replace(":", "")[:12]
    if len(hex_chars) == 12 and _MAC_PLAIN_RE.match(hex_chars):
        return _normalize_mac(hex_chars)
    return None
