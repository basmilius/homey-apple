from __future__ import annotations

from ..homepod_base.device import HomePodBaseDevice


class HomePodMiniDevice(HomePodBaseDevice):
    """Homey device representing a paired HomePod Mini."""


homey_export = HomePodMiniDevice
