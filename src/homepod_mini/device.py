from __future__ import annotations

from ..homepod_base.device import HomePodBaseDevice


class HomePodMiniDevice(HomePodBaseDevice):
    """Homey device representing a paired HomePod Mini."""

    @property
    def _device_type_name(self) -> str:
        return 'HomePod Mini'


homey_export = HomePodMiniDevice
