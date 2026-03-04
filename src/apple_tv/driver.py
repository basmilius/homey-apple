from __future__ import annotations

from homey.driver import Driver

from .pairing import AppleTVPairing


class AppleTVDriver(Driver):
    """Homey driver for Apple TV devices."""

    async def on_init(self) -> None:
        self.log('Apple TV Driver has been initialized.')

    async def on_pair(self, session) -> None:
        pairing = AppleTVPairing(
            session=session,
            strategy=self.get_discovery_strategy(),
            known_devices=list(self.get_devices()),
        )

        pairing.on_log = lambda msg: self.log(msg)
        pairing.on_error = lambda err: self.error(err)

        await pairing.start()


homey_export = AppleTVDriver
