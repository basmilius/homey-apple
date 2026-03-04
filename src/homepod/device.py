from __future__ import annotations

from ..homepod_base.device import HomePodBaseDevice


class HomePodDevice(HomePodBaseDevice):
    """Homey device representing a paired HomePod."""


homey_export = HomePodDevice
