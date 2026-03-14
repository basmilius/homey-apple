from __future__ import annotations

import re
from abc import abstractmethod
from typing import Any

from homey.driver import Driver

from .pairing import HomePodBasePairing


class HomePodBaseDriver(Driver):
    """Abstract base driver for HomePod and HomePod Mini."""

    @property
    @abstractmethod
    def model_filter(self) -> re.Pattern:
        """Regex pattern to match device model strings during pairing."""

    async def on_pair(self, session: Any) -> None:
        pairing = HomePodBasePairing(
            session=session,
            strategy=self.get_discovery_strategy(),
            model_filter=self.model_filter,
            known_devices=list(self.get_devices()),
        )

        pairing.on_log = lambda msg: self.log(msg)
        pairing.on_error = lambda err: self.error(err)

        await pairing.start()
