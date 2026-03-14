"""HomePod driver."""

from __future__ import annotations

import re

from lib.homepod_base_driver import HomePodBaseDriver


class HomePodDriver(HomePodBaseDriver):
    """Driver for full-size HomePod (AudioAccessory1,x and AudioAccessory6,x)."""

    @property
    def model_filter(self) -> re.Pattern:
        return re.compile(r'AudioAccessory[16],\d+')

    async def on_init(self) -> None:
        await super().on_init()
        self.log('HomePod Driver has been initialized.')
