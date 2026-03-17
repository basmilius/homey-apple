from __future__ import annotations

from typing import Any

from homey.app import App

from .apple_tv.flow import AppleTVFlow
from .homepod_base.flow import HomePodFlow
from .storage.app_settings_storage import AppSettingsStorage


class AppleApp(App):
    """Main application class for the Apple TV & HomePod Homey app."""

    # Class-level reference so devices can access the running app instance
    # without a direct `self.app` property in the Homey Python SDK.
    _instance: AppleApp | None = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._apple_tv_flow: AppleTVFlow | None = None
        self._homepod_flow: HomePodFlow | None = None
        self._storage: AppSettingsStorage | None = None

    @property
    def apple_tv_flow(self) -> AppleTVFlow:
        if self._apple_tv_flow is None:
            raise RuntimeError('AppleApp.apple_tv_flow accessed before on_init completed.')
        return self._apple_tv_flow

    @property
    def storage(self) -> AppSettingsStorage:
        if self._storage is None:
            raise RuntimeError('AppleApp.storage accessed before on_init completed.')
        return self._storage

    @property
    def homepod_flow(self) -> HomePodFlow:
        if self._homepod_flow is None:
            raise RuntimeError('AppleApp.homepod_flow accessed before on_init completed.')
        return self._homepod_flow

    async def on_init(self) -> None:
        AppleApp._instance = self

        self._storage = AppSettingsStorage(self.homey)
        await self._storage.load()

        self._apple_tv_flow = AppleTVFlow(self)
        self._apple_tv_flow.register()

        self._homepod_flow = HomePodFlow(self)
        self._homepod_flow.register()

        self.log('Apple TV & HomePod has been initialized')

    async def on_uninit(self) -> None:
        AppleApp._instance = None


homey_export = AppleApp
