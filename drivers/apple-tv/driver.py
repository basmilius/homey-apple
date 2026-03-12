"""Apple TV driver — handles pairing sessions."""

from __future__ import annotations

import homey

from lib.apple_tv_pairing import AppleTVPairing


class AppleTVDriver(homey.Driver):
    async def on_init(self) -> None:
        self.log('Apple TV Driver has been initialized.')

    async def on_pair(self, session: homey.Driver.PairSession) -> None:
        pairing = AppleTVPairing(
            session=session,
            known_devices=self.get_devices(),
            homey=self.homey,
        )
        await pairing.start()
