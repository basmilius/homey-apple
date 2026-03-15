"""Abstract base driver for HomePod and HomePod Mini."""

from __future__ import annotations

import re
from abc import abstractmethod

import homey
from homey.driver import Driver as HomeyDriver


class HomePodBaseDriver(HomeyDriver):
    """Base driver that handles pairing for both HomePod models."""

    @property
    @abstractmethod
    def model_filter(self) -> re.Pattern:
        """Regex that matches the `model` mDNS TXT record for this variant."""

    async def on_pair(self, session: homey.Driver.PairSession) -> None:
        from .homepod_pairing import HomePodBasePairing

        pairing = HomePodBasePairing(
            session=session,
            model_filter=self.model_filter,
            known_devices=self.get_devices(),
            homey=self.homey,
        )
        await pairing.start()
