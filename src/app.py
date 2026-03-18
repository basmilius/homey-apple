from __future__ import annotations

import asyncio
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

        self._apple_tv_flow: AppleTVFlow | None = None
        self._homepod_flow: HomePodFlow | None = None
        self._storage: AppSettingsStorage | None = None

        loop = asyncio.get_running_loop()
        self._default_exception_handler = loop.get_exception_handler()
        loop.set_exception_handler(self._handle_async_exception)

        self._storage = AppSettingsStorage(self.homey)
        await self._storage.load()

        self._apple_tv_flow = AppleTVFlow(self)
        self._apple_tv_flow.register()

        self._homepod_flow = HomePodFlow(self)
        self._homepod_flow.register()

        self.log('Apple TV & HomePod has been initialized')

    async def on_uninit(self) -> None:
        loop = asyncio.get_running_loop()
        if self._default_exception_handler is not None:
            loop.set_exception_handler(self._default_exception_handler)
        else:
            loop.set_exception_handler(None)

        AppleApp._instance = None

    def _handle_async_exception(self, loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        """Global handler for unhandled asyncio task exceptions.

        Suppresses known pyatv internal errors (e.g. knock failures) that
        cannot be caught at the application level, and forwards everything
        else to the default handler.
        """
        exception = context.get('exception')

        if exception is not None and self._is_pyatv_exception(exception):
            self.log(f'Suppressed pyatv internal error: {exception}')
            return

        if self._default_exception_handler is not None:
            self._default_exception_handler(loop, context)
        else:
            loop.default_exception_handler(context)

    @staticmethod
    def _is_pyatv_exception(exception: BaseException) -> bool:
        """Check if an exception originated from pyatv internals."""
        module = getattr(type(exception), '__module__', '') or ''
        if module.startswith('pyatv'):
            return True

        tb = exception.__traceback__
        while tb is not None:
            filename = tb.tb_frame.f_code.co_filename
            if 'pyatv' in filename:
                return True
            tb = tb.tb_next

        return False


homey_export = AppleApp
