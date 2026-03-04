from __future__ import annotations

import asyncio
import io
from typing import TYPE_CHECKING, Any

import pyatv
import pyatv.interface as pyatv_interface
from pyatv.const import DeviceState

if TYPE_CHECKING:
    from homey.app import App
    from homey.device import Device
    from homey.image import Image

    from ..app import AppleApp

_DEBOUNCE_DELAY_S = 1.0


class _PushListener(pyatv_interface.PushListener):
    """Receives push-updates (now-playing state) from pyatv."""

    def __init__(self, logic: AirPlayLogic) -> None:
        self._logic = logic

    def playstatus_update(
        self,
        updater: pyatv_interface.PushUpdater,
        playing: pyatv_interface.Playing,
    ) -> None:
        asyncio.ensure_future(self._logic._on_playing_update(playing))

    def playstatus_error(
        self,
        updater: pyatv_interface.PushUpdater,
        exception: Exception,
    ) -> None:
        self._logic._device.error('Push update error:', exception)


class AirPlayLogic:
    """
    Handles now-playing info and artwork updates for a device connected via
    pyatv AirPlay (or RAOP).

    This class is shared between Apple TV and HomePod devices.
    """

    @property
    def device_name(self) -> str:
        return self._device.get_name()

    def __init__(self, device: Device, app: AppleApp) -> None:
        self._device = device
        self._app = app
        self._artwork: Image | None = None
        self._artwork_hash: str | None = None
        self._debounce_task: asyncio.Task | None = None
        self._pending_playing: pyatv_interface.Playing | None = None
        self._atv: pyatv_interface.AppleTV | None = None
        self._push_listener: _PushListener | None = None

    async def initialize(self) -> None:
        """Register artwork image with Homey and clear now-playing state."""
        self._artwork = await self._device.homey.images.create_image()
        await self._device.set_album_art_image(self._artwork)
        await self.clear_now_playing()
        await self.update_artwork_url()

    async def uninitialize(self) -> None:
        """Stop push updates and clean up the artwork image."""
        if self._atv is not None:
            try:
                self._atv.push_updater.stop()
            except Exception:
                pass
        if self._artwork is not None:
            await self._device.homey.images.unregister_image(self._artwork)
            self._artwork = None

    def set_atv(self, atv: pyatv_interface.AppleTV) -> None:
        """Attach pyatv interface and start push updates."""
        self._atv = atv
        self._push_listener = _PushListener(self)
        atv.push_updater.listener = self._push_listener
        asyncio.ensure_future(self._start_push_updater())

    async def _start_push_updater(self) -> None:
        try:
            await self._atv.push_updater.start()
        except Exception as err:
            self._device.error('Failed to start push updater:', err)

    async def clear_now_playing(self) -> None:
        """Reset all now-playing capabilities to their default/empty values."""
        try:
            self._artwork_hash = None

            if self._artwork is not None:
                self._artwork.local_url = None
                self._artwork.cloud_url = None
                await self._artwork.update() if hasattr(self._artwork, 'update') else None

            await self._update_now_playing_app(None, None)

            await self._device.set_capability_value('speaker_album', '')
            await self._device.set_capability_value('speaker_artist', '')
            await self._device.set_capability_value('speaker_track', '')
            await self._device.set_capability_value('speaker_duration', -1)
            await self._device.set_capability_value('speaker_position', -1)
            await self._device.set_capability_value('speaker_playing', False)

            self._device.log(self.device_name, 'Now playing info cleared.')
        except Exception as err:
            self._device.log(self.device_name, 'Failed to clear now playing info', err)

    async def update_artwork_url(self) -> None:
        """Push the current artwork cloud/local URLs to the capability."""
        if not self._device.has_capability('artwork_url'):
            return

        if self._artwork is None:
            return

        cloud_url = getattr(self._artwork, 'cloud_url', None)
        if not cloud_url:
            return

        import time
        cache_buster = int(time.time() * 1000)
        artwork_url = f'{cloud_url}?v={cache_buster}'
        await self._device.set_capability_value('artwork_url', artwork_url)
        self._device.log(self.device_name, 'Artwork URL updated.', artwork_url)

        local_url = getattr(self._artwork, 'local_url', None)
        local_url_with_cache = f'{local_url}?v={cache_buster}' if local_url else ''

        await self._trigger_artwork_url_updated(local_url_with_cache, artwork_url)

    async def _trigger_artwork_url_updated(
        self, local_url: str, cloud_url: str
    ) -> None:
        from ..apple_tv.device import AppleTVDevice
        from ..homepod_base.device import HomePodBaseDevice

        if isinstance(self._device, AppleTVDevice):
            await self._app.apple_tv_flow.trigger_artwork_url_updated(
                self._device, local_url, cloud_url
            )
        elif isinstance(self._device, HomePodBaseDevice):
            await self._app.homepod_flow.trigger_artwork_url_updated(
                self._device, local_url, cloud_url
            )

    async def _on_playing_update(self, playing: pyatv_interface.Playing) -> None:
        """Debounced handler for push-update playback state changes."""
        self._pending_playing = playing

        if self._debounce_task is not None:
            self._debounce_task.cancel()

        self._debounce_task = asyncio.ensure_future(self._debounced_update())

    async def _debounced_update(self) -> None:
        try:
            await asyncio.sleep(_DEBOUNCE_DELAY_S)
            playing = self._pending_playing
            if playing is not None:
                await self._update_now_playing(playing)
        except asyncio.CancelledError:
            pass

    async def _update_now_playing(self, playing: pyatv_interface.Playing) -> None:
        """Update Homey capabilities from a Playing object."""
        # Do not update if the device is turned off
        if (
            self._device.has_capability('onoff')
            and self._device.get_capability_value('onoff') is False
        ):
            return

        device_state = playing.device_state
        is_playing = device_state == DeviceState.Playing

        self._device.log(
            self.device_name,
            'Now playing update',
            playing.title,
            device_state,
        )

        try:
            await self._device.set_capability_value('speaker_playing', is_playing)

            if playing.album is not None:
                await self._device.set_capability_value('speaker_album', playing.album)

            if playing.artist is not None:
                await self._device.set_capability_value('speaker_artist', playing.artist)

            if playing.title is not None:
                await self._device.set_capability_value('speaker_track', playing.title)

            if playing.total_time is not None:
                await self._device.set_capability_value(
                    'speaker_duration', playing.total_time
                )

            if playing.position is not None:
                await self._device.set_capability_value(
                    'speaker_position', playing.position
                )

            # Update artwork
            artwork_hash = playing.hash
            if artwork_hash != self._artwork_hash:
                await self._fetch_artwork(artwork_hash)

            # Update now-playing app info
            if is_playing:
                app = getattr(playing, 'app', None) if hasattr(playing, 'app') else None

                if self._atv is not None:
                    try:
                        app = await self._atv.metadata.app()
                    except Exception:
                        app = None

                if app is not None:
                    await self._update_now_playing_app(
                        getattr(app, 'bundle_identifier', None),
                        getattr(app, 'name', None),
                    )
                else:
                    await self._update_now_playing_app(None, None)
            else:
                await self._update_now_playing_app(None, None)

        except Exception as err:
            self._device.log(self.device_name, 'Failed to update now playing info', err)

    async def _fetch_artwork(self, artwork_hash: str | None) -> None:
        """Fetch and update artwork from pyatv."""
        if self._atv is None or self._artwork is None:
            return

        try:
            artwork_info = await self._atv.metadata.artwork()
            if artwork_info is None or artwork_info.bytes is None:
                await self._update_artwork_data(None)
                return

            self._artwork_hash = artwork_hash
            await self._update_artwork_data(artwork_info.bytes)
        except Exception as err:
            self._device.log(self.device_name, 'Failed to fetch artwork:', err)

    async def _update_artwork_data(self, data: bytes | None) -> None:
        """Push raw artwork bytes (or None) into the Homey Image."""
        if self._artwork is None:
            return

        try:
            if data:
                await self._artwork.set_stream(
                    lambda stream: _write_bytes_to_stream(stream, data)
                )
            else:
                self._artwork.local_url = None

            await self.update_artwork_url()
        except Exception as err:
            self._device.log(self.device_name, 'Failed to update artwork:', err)

    async def _update_now_playing_app(
        self,
        bundle_identifier: str | None,
        display_name: str | None,
    ) -> None:
        if not self._device.has_capability('now_playing_app'):
            return

        current = self._device.get_capability_value('now_playing_app')
        if current == display_name:
            return

        self._device.log(
            self.device_name, 'Now playing app changed.', bundle_identifier, display_name
        )

        await self._device.set_capability_value('now_playing_app', display_name)

        from ..apple_tv.device import AppleTVDevice
        if isinstance(self._device, AppleTVDevice):
            await self._app.apple_tv_flow.trigger_now_playing_app_changes(
                self._device,
                bundle_identifier or '-',
                display_name or '-',
            )


def _write_bytes_to_stream(stream: Any, data: bytes) -> None:
    """Write bytes to a stream-like object."""
    buf = io.BytesIO(data)
    try:
        stream.write(buf.read())
    except Exception:
        pass
