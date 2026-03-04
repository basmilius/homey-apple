from __future__ import annotations

import re

from ..homepod_base.driver import HomePodBaseDriver


class HomePodDriver(HomePodBaseDriver):
    """Homey driver for HomePod devices."""

    @property
    def model_filter(self) -> re.Pattern:
        return re.compile(r'AudioAccessory[16],\d')

    async def on_init(self) -> None:
        await super().on_init()
        self.log('HomePod Driver has been initialized.')


homey_export = HomePodDriver
