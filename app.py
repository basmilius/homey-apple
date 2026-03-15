from homey.app import App

from app.lib.apple_tv_flow import AppleTVFlow
from app.lib.homepod_flow import HomePodFlow


class AppleApp(App):
    """Main app class for the Apple TV & HomePod Homey app."""

    async def on_init(self) -> None:
        self.apple_tv_flow = AppleTVFlow(self)
        self.homepod_flow = HomePodFlow(self)

        await self.apple_tv_flow.register()
        await self.homepod_flow.register()

        self.log('Apple TV & HomePod has been initialized')

    async def on_uninit(self) -> None:
        self.log('Apple TV & HomePod has been uninitialized')


homey_export = AppleApp
