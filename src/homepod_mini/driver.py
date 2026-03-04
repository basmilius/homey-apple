from __future__ import annotations

import re

from ..homepod_base.driver import HomePodBaseDriver


class HomePodMiniDriver(HomePodBaseDriver):
    """Homey driver for HomePod Mini devices."""

    @property
    def model_filter(self) -> re.Pattern:
        return re.compile(r'AudioAccessory5,\d')

    async def on_init(self) -> None:
        await super().on_init()
        self.log('HomePod Mini Driver has been initialized.')


homey_export = HomePodMiniDriver
