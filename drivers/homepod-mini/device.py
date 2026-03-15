"""HomePod Mini device."""

from __future__ import annotations

from app.lib.homepod_base_device import HomePodBaseDevice


class HomePodMiniDevice(HomePodBaseDevice):
    """Represents a HomePod Mini."""

homey_export = HomePodMiniDevice
