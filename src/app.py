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

        self._register_widget_autocomplete()

        self.log('Apple TV & HomePod has been initialized')

    def _register_widget_autocomplete(self) -> None:
        """Register autocomplete listeners for widget settings."""
        try:
            widget = self.homey.dashboards.get_widget('mini_player')
            widget.register_setting_autocomplete_listener('device', self._autocomplete_mini_player_device)
        except Exception as err:
            self.error('Failed to register mini_player widget autocomplete:', err)

        try:
            widget = self.homey.dashboards.get_widget('apple_tv_remote')
            widget.register_setting_autocomplete_listener('device', self._autocomplete_apple_tv_remote_device)
        except Exception as err:
            self.error('Failed to register apple_tv_remote widget autocomplete:', err)

    async def _autocomplete_mini_player_device(self, query: str, settings: dict) -> list:
        """Return all Apple TV and HomePod devices for the device autocomplete setting."""
        _driver_labels = {
            'apple-tv': 'Apple TV',
            'homepod': 'HomePod',
            'homepod-mini': 'HomePod Mini',
        }
        results = []
        for driver_id, label in _driver_labels.items():
            try:
                driver = self.homey.drivers.get_driver(driver_id)
                devices = driver.get_devices()
            except Exception as err:
                self.error(f'Failed to enumerate driver "{driver_id}":', err)
                continue

            for device in devices:
                try:
                    name = device.get_name()
                    if not query or query.lower() in name.lower():
                        results.append({
                            'name': name,
                            'description': label,
                            'icon': f'/drivers/{driver_id}/assets/icon.svg',
                            'data': {'id': device._id, 'driverId': driver_id},
                        })
                except Exception:
                    continue
        return results

    async def _autocomplete_apple_tv_remote_device(self, query: str, settings: dict) -> list:
        """Return all Apple TV devices for the apple_tv_remote widget device autocomplete setting."""
        results = []
        try:
            driver = self.homey.drivers.get_driver('apple-tv')
            for device in driver.get_devices():
                name = device.get_name()
                if not query or query.lower() in name.lower():
                    results.append({
                        'name': name,
                        'description': 'Apple TV',
                        'icon': '/drivers/apple-tv/assets/icon.svg',
                        'data': {'id': device._id, 'driverId': 'apple-tv'},
                    })
        except Exception:
            pass
        return results

    async def on_uninit(self) -> None:
        AppleApp._instance = None


homey_export = AppleApp
