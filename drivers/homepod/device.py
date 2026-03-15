"""HomePod device."""

from __future__ import annotations

from app.lib.homepod_base_device import HomePodBaseDevice


class HomePodDevice(HomePodBaseDevice):
    """Represents a full-size HomePod."""

homey_export = HomePodDevice
