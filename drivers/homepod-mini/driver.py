"""HomePod Mini driver."""

from __future__ import annotations

import re

from app.lib.homepod_base_driver import HomePodBaseDriver


class HomePodMiniDriver(HomePodBaseDriver):
    """Driver for HomePod Mini (AudioAccessory5,x)."""

    @property
    def model_filter(self) -> re.Pattern:
        return re.compile(r'AudioAccessory5,\d+')

    async def on_init(self) -> None:
        await super().on_init()
        self.log('HomePod Mini Driver has been initialized.')

homey_export = HomePodMiniDriver
