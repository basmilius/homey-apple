from __future__ import annotations

from homey.app import App

from .apple_tv.flow import AppleTVFlow
from .homepod_base.flow import HomePodFlow


class AppleApp(App):
    """Main application class for the Apple TV & HomePod Homey app."""

    # Class-level reference so devices can access the running app instance
    # without a direct `self.app` property in the Homey Python SDK.
    _instance: AppleApp | None = None

    @property
    def apple_tv_flow(self) -> AppleTVFlow:
        return self._apple_tv_flow

    @property
    def homepod_flow(self) -> HomePodFlow:
        return self._homepod_flow

    async def on_init(self) -> None:
        AppleApp._instance = self

        self._apple_tv_flow = AppleTVFlow(self)
        self._apple_tv_flow.register()

        self._homepod_flow = HomePodFlow(self)
        self._homepod_flow.register()

        self.log('Apple TV & HomePod has been initialized')

    async def on_uninit(self) -> None:
        AppleApp._instance = None


homey_export = AppleApp
