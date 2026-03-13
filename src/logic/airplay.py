from __future__ import annotations

import asyncio
import inspect
import time
from typing import TYPE_CHECKING, Any

import pyatv.interface as pyatv_interface
from pyatv.const import DeviceState, PowerState, RepeatState, ShuffleState

if TYPE_CHECKING:
    from homey.device import Device
    from homey.image import Image

    from ..app import AppleApp

_DEBOUNCE_DELAY_S = 0.3


class AirPlayLogic(pyatv_interface.PushListener, pyatv_interface.PowerListener):
    """
    Receives push updates (now-playing state and power state) from pyatv and
    syncs them to Homey capabilities.

    Shared between Apple TV and HomePod devices.
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
        self._update_task: asyncio.Task | None = None
        self._pending_playing: pyatv_interface.Playing | None = None
        self._atv: pyatv_interface.AppleTV | None = None
        self._shuffle: bool = False
        self._repeat: str = 'off'
        self._position_update_time: float = 0.0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def _call_image_method(self, method_name: str, *args: Any) -> None:
        """Call a method on the artwork image, awaiting if it returns a coroutine."""
        if self._artwork is None:
            return
        method = getattr(self._artwork, method_name, None)
        if callable(method):
            result = method(*args)
            if inspect.isawaitable(result):
                await result

    async def initialize(self) -> None:
        """Register artwork image with Homey and clear now-playing state."""
        self._artwork = await self._device.homey.images.create_image()
        try:
            await self._device.set_album_art_image(self._artwork)
            await self.clear_now_playing()
            await self.update_artwork_url()
        except Exception:
            await self._device.homey.images.unregister_image(self._artwork)
            self._artwork = None
            raise

    async def uninitialize(self) -> None:
        """Stop push updates and clean up the artwork image."""
        self.stop()
        if self._artwork is not None:
            try:
                await self._device.homey.images.unregister_image(self._artwork)
            except Exception:
                pass
            self._artwork = None

    def set_atv(self, atv: pyatv_interface.AppleTV) -> None:
        """Attach pyatv interface and register as push + power listener."""
        self._atv = atv

        atv.push_updater.listener = self
        atv.push_updater.start(initial_delay=0)

        # Power listener is only available on devices with Companion protocol.
        try:
            atv.power.listener = self
        except Exception:
            pass

    def stop(self) -> None:
        """Stop push updates (called on disconnect / uninit)."""
        if self._debounce_task is not None:
            self._debounce_task.cancel()
            self._debounce_task = None

        if self._update_task is not None and not self._update_task.done():
            self._update_task.cancel()
            self._update_task = None

        if self._atv is not None:
            try:
                self._atv.push_updater.stop()
            except Exception:
                pass
            try:
                self._atv.power.listener = None
            except Exception:
                pass

    # ------------------------------------------------------------------
    # PushListener implementation
    # ------------------------------------------------------------------

    def playstatus_update(
        self,
        updater: pyatv_interface.PushUpdater,
        playing: pyatv_interface.Playing,
    ) -> None:
        asyncio.create_task(self._on_playing_update(playing))

    def playstatus_error(
        self,
        updater: pyatv_interface.PushUpdater,
        exception: Exception,
    ) -> None:
        self._device.error('Push update error:', exception)

    # ------------------------------------------------------------------
    # PowerListener implementation
    # ------------------------------------------------------------------

    def powerstate_update(
        self,
        old_state: PowerState,
        new_state: PowerState,
    ) -> None:
        asyncio.create_task(self._handle_power_state(new_state))

    # ------------------------------------------------------------------
    # Now-playing state
    # ------------------------------------------------------------------

    async def clear_now_playing(self) -> None:
        """Reset all now-playing capabilities to their default/empty values."""
        try:
            self._artwork_hash = None

            await self._call_image_method('set_url', '')
            await self._call_image_method('update')

            await self._update_now_playing_app(None, None)

            await self._device.set_capability_value('speaker_album', '')
            await self._device.set_capability_value('speaker_artist', '')
            await self._device.set_capability_value('speaker_track', '')
            await self._device.set_capability_value('speaker_duration', -1)
            await self._device.set_capability_value('speaker_position', -1)
            await self._device.set_capability_value('speaker_playing', False)

            self._shuffle = False
            self._repeat = 'off'

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
        local_url = getattr(self._artwork, 'local_url', None)

        base_url = cloud_url or local_url
        if not base_url:
            return

        cache_buster = int(time.time() * 1000)
        artwork_url = f'{base_url}?v={cache_buster}'
        await self._device.set_capability_value('artwork_url', artwork_url)
        self._device.log(self.device_name, 'Artwork URL updated.', artwork_url)

        cloud_url_with_cache = f'{cloud_url}?v={cache_buster}' if cloud_url else ''
        local_url_with_cache = f'{local_url}?v={cache_buster}' if local_url else ''

        if self._device.has_capability('artwork_url_local'):
            await self._device.set_capability_value('artwork_url_local', local_url_with_cache)

        if self._device.has_capability('artwork_url_cloud'):
            await self._device.set_capability_value('artwork_url_cloud', cloud_url_with_cache)

        await self._trigger_artwork_url_updated(local_url_with_cache, cloud_url_with_cache)
        await self._emit_mini_player_update()

    async def _trigger_artwork_url_updated(self, local_url: str, cloud_url: str) -> None:
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

    # ------------------------------------------------------------------
    # Power state
    # ------------------------------------------------------------------

    async def _handle_power_state(self, new_state: PowerState) -> None:
        """Handle power state change events."""
        self._device.log('Power state changed:', new_state)

        is_on = new_state == PowerState.On

        try:
            if self._device.has_capability('onoff'):
                await self._device.set_capability_value('onoff', is_on)

            if self._device.has_capability('power'):
                await self._device.set_capability_value(
                    'power',
                    self._device.homey.i18n.translate(
                        'capability.power.on' if is_on else 'capability.power.off'
                    ),
                )
        except Exception as err:
            self._device.error('Failed to set power state:', err)

        if not is_on:
            await self.clear_now_playing()

    # ------------------------------------------------------------------
    # Debounced now-playing updates
    # ------------------------------------------------------------------

    async def _on_playing_update(self, playing: pyatv_interface.Playing) -> None:
        """Debounced handler for push-update playback state changes."""
        if playing.position is not None:
            self._position_update_time = time.time()

        self._pending_playing = playing

        if self._debounce_task is not None:
            self._debounce_task.cancel()

        self._debounce_task = asyncio.create_task(self._debounced_update())

    async def _debounced_update(self) -> None:
        try:
            await asyncio.sleep(_DEBOUNCE_DELAY_S)
        except asyncio.CancelledError:
            return

        playing = self._pending_playing
        if playing is not None:
            self._update_task = asyncio.create_task(self._update_now_playing(playing))

    async def _update_now_playing(self, playing: pyatv_interface.Playing) -> None:
        """Update Homey capabilities from a Playing object."""
        if (
            self._device.has_capability('onoff')
            and self._device.get_capability_value('onoff') is False
        ):
            return

        device_state = playing.device_state
        is_playing = device_state == DeviceState.Playing

        self._device.log(
            self.device_name, 'Now playing update',
            f'state={device_state}',
            f'title={playing.title!r}',
            f'artist={playing.artist!r}',
            f'album={playing.album!r}',
            f'hash={playing.hash!r}',
        )

        try:
            await self._device.set_capability_value('speaker_playing', is_playing)

            if playing.album is not None:
                await self._device.set_capability_value('speaker_album', playing.album)

            if playing.title is not None:
                await self._device.set_capability_value('speaker_track', playing.title)

            if playing.total_time is not None:
                await self._device.set_capability_value('speaker_duration', playing.total_time)

            if playing.position is not None:
                await self._device.set_capability_value('speaker_position', playing.position)

            # Update volume_set capability from the audio interface.
            if self._device.has_capability('volume_set') and self._atv is not None:
                try:
                    volume = self._atv.audio.volume
                    if volume is not None:
                        await self._device.set_capability_value('volume_set', volume / 100.0)
                except Exception:
                    pass

            # Shuffle / repeat state
            shuffle_state = getattr(playing, 'shuffle', None)
            if shuffle_state is not None:
                self._shuffle = shuffle_state != ShuffleState.Off

            repeat_state = getattr(playing, 'repeat', None)
            if repeat_state == RepeatState.Track:
                self._repeat = 'one'
            elif repeat_state == RepeatState.All:
                self._repeat = 'all'
            elif repeat_state is not None:
                self._repeat = 'off'

            # Artwork
            artwork_hash = playing.hash
            if artwork_hash != self._artwork_hash:
                await self._fetch_artwork(artwork_hash)

            # Now-playing app — resolve before artist fallback.
            app_name: str | None = None
            if is_playing and self._atv is not None:
                try:
                    app = self._atv.metadata.app
                except Exception:
                    app = None

                if app is not None:
                    app_name = getattr(app, 'name', None)
                    await self._update_now_playing_app(
                        getattr(app, 'identifier', None),
                        app_name,
                    )
                else:
                    await self._update_now_playing_app(None, None)
            else:
                await self._update_now_playing_app(None, None)

            # Artist — fall back to app name when artist is not available
            # (e.g. video content on Netflix, YouTube, etc.).
            artist = playing.artist if playing.artist is not None else app_name
            if artist is not None:
                await self._device.set_capability_value('speaker_artist', artist)

            await self._emit_mini_player_update()

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

            # Skip HEIC artwork — Homey cannot display it.
            mimetype = getattr(artwork_info, 'mimetype', '') or ''
            if 'heic' in mimetype.lower() or 'heif' in mimetype.lower():
                self._device.log(
                    self.device_name,
                    f'Skipping HEIC artwork (mimetype={mimetype})',
                )
                return

            await self._update_artwork_data(artwork_info.bytes)
            self._artwork_hash = artwork_hash
        except Exception as err:
            self._device.error(self.device_name, 'Failed to fetch artwork:', err)

    async def _update_artwork_data(self, data: bytes | None) -> None:
        """Push raw artwork bytes (or None) into the Homey Image."""
        if self._artwork is None:
            return

        try:
            if data:
                async def write_to_stream(stream: Any) -> None:
                    stream.write(data)

                await self._call_image_method('set_stream', write_to_stream)

            await self._call_image_method('update')
            await self.update_artwork_url()
        except Exception as err:
            self._device.error(self.device_name, 'Failed to update artwork data:', err)

    async def _emit_mini_player_update(self) -> None:
        """Emit a realtime event so mini player widgets can update without polling."""
        def cap(name: str) -> Any:
            try:
                return self._device.get_capability_value(name)
            except Exception:
                return None

        try:
            await self._device.homey.api.realtime('apple-mini-player-update', {
                'deviceId': self._device._id,
                'deviceName': self._device.get_name(),
                'track': cap('speaker_track'),
                'artist': cap('speaker_artist'),
                'album': cap('speaker_album'),
                'playing': cap('speaker_playing'),
                'position': cap('speaker_position'),
                'duration': cap('speaker_duration'),
                'volume': cap('volume_set'),
                'artworkUrl': cap('artwork_url'),
                'shuffle': self._shuffle,
                'repeat': self._repeat,
                'positionTimestamp': int(self._position_update_time * 1000),
            })
        except Exception as err:
            self._device.error(self.device_name, 'Failed to emit mini player update:', err)

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
