import homey

from drivers.apple_tv.flow import AppleTVFlow
from lib.homepod_flow import HomePodFlow


class AppleApp(homey.App):
    """Main app class for the Apple TV & HomePod Homey app."""

    def __init__(self):
        super().__init__()
        self.apple_tv_flow: AppleTVFlow | None = None
        self.homepod_flow: HomePodFlow | None = None

    async def on_init(self) -> None:
        self.apple_tv_flow = AppleTVFlow(self)
        self.homepod_flow = HomePodFlow(self)

        await self.apple_tv_flow.register()
        await self.homepod_flow.register()

        self.log('Apple TV & HomePod has been initialized')

    async def on_uninit(self) -> None:
        self.log('Apple TV & HomePod has been uninitialized')
