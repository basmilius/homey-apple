"""Apple TV driver — handles pairing sessions."""

from __future__ import annotations

import homey
from homey.driver import Driver as HomeyDriver
from homey.device import Device as HomeyDevice

from app.lib.apple_tv_pairing import AppleTVPairing


class AppleTVDriver(HomeyDriver):
    async def on_init(self) -> None:
        self.log('Apple TV Driver has been initialized.')

    async def on_pair(self, session: homey.Driver.PairSession) -> None:
        pairing = AppleTVPairing(
            session=session,
            known_devices=self.get_devices(),
            homey=self.homey,
        )
        await pairing.start()

    async def on_repair(self, session: homey.Driver.PairSession, device: HomeyDevice | None = None) -> None:
        device_id = device.get_data().get('id') if device else None
        self.log(f'on_repair called (id={device_id})')

        pairing = AppleTVPairing(
            session=session,
            known_devices=self.get_devices(),
            homey=self.homey,
            repair_device_id=device_id,
        )
        await pairing.start()

homey_export = AppleTVDriver
