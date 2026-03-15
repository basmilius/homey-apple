"""AirPlay push-update listener — receives now-playing and power state from pyatv
and syncs them to Homey capabilities."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from pyatv.const import DeviceState, MediaType, PowerState
from pyatv.interface import Playing, PowerListener, PushListener

if TYPE_CHECKING:
    import homey
    import pyatv.interface as iface
    from pyatv.interface import AppleTV

logger = logging.getLogger(__name__)

# Map pyatv MediaType to the Homey media_type capability string
_MEDIA_TYPE_MAP: dict[MediaType, str] = {
    MediaType.Music: 'music',
    MediaType.Video: 'video',
    MediaType.TV: 'video',
    MediaType.Unknown: 'unknown',
}


class AirPlayLogic(PushListener, PowerListener):
    """Receives push updates from pyatv and updates Homey capabilities."""

    def __init__(self, device: homey.Device) -> None:
        self._device = device
        self._atv: AppleTV | None = None
        self._artwork_identifier: str | None = None
        # Debounce handle for now_playing_app updates
        self._now_playing_app_task: asyncio.Task | None = None
        # Track the app name we're debouncing toward (prevents livelock on repeated updates)
        self._pending_now_playing_app: str | None = None
        # Track all fire-and-forget tasks so stop() can cancel them
        self._push_tasks: set[asyncio.Task] = set()

    def _track_task(self, coro) -> asyncio.Task:
        """Create a tracked task that is automatically removed when done."""
        task = asyncio.create_task(coro)
        self._push_tasks.add(task)
        task.add_done_callback(self._push_tasks.discard)
        return task

    def set_protocol(self, atv: AppleTV) -> None:
        """Attach to a (new) pyatv AppleTV connection."""
        self._atv = atv
        self._atv.push_updater.listener = self
        self._atv.push_updater.start(initial_delay=0)
        self._atv.power.listener = self

    def stop(self) -> None:
        """Stop push updates and cancel any in-flight tasks."""
        if self._atv is not None:
            try:
                self._atv.push_updater.stop()
            except Exception:
                pass
            try:
                self._atv.power.listener = None
            except Exception:
                pass
        for task in list(self._push_tasks):
            task.cancel()
        self._push_tasks.clear()

    # ------------------------------------------------------------------
    # PushListener callbacks
    # ------------------------------------------------------------------

    def playstatus_update(self, updater: iface.PushUpdater, playing: Playing) -> None:
        self._track_task(self._handle_playstatus(playing))

    def playstatus_error(self, updater: iface.PushUpdater, exception: Exception) -> None:
        self._device.log(f'Push update error: {exception}')

    def powerstate_update(
        self,
        old_state: PowerState,
        new_state: PowerState,
    ) -> None:
        self._track_task(self._handle_powerstate(new_state))

    # ------------------------------------------------------------------
    # Internal handlers
    # ------------------------------------------------------------------

    async def clear_now_playing(self) -> None:
        """Reset all now-playing capabilities to their defaults."""
        # Cancel any pending app-change debounce so it can't fire after clear
        if self._now_playing_app_task and not self._now_playing_app_task.done():
            self._now_playing_app_task.cancel()
            self._now_playing_app_task = None
        self._pending_now_playing_app = None
        try:
            self._artwork_identifier = None
            await self._device.set_capability_value('speaker_album', '')
            await self._device.set_capability_value('speaker_artist', '')
            await self._device.set_capability_value('speaker_track', '')
            await self._device.set_capability_value('speaker_duration', -1)
            await self._device.set_capability_value('speaker_position', -1)
            await self._device.set_capability_value('speaker_playing', False)
            self._device.log('Now playing info cleared.')
        except Exception as err:
            self._device.error(f'Failed to clear now playing info: {err}')

    async def _handle_playstatus(self, playing: Playing) -> None:
        device = self._device

        # Do not update if device is off
        if device.has_capability('onoff') and not device.get_capability_value('onoff'):
            return

        try:
            is_playing = playing.device_state == DeviceState.Playing

            await device.set_capability_value('speaker_playing', is_playing)
            await device.set_capability_value('speaker_track', playing.title or '')
            await device.set_capability_value('speaker_artist', playing.artist or '')
            await device.set_capability_value('speaker_album', playing.album or '')

            if playing.total_time is not None:
                await device.set_capability_value('speaker_duration', playing.total_time)

            if playing.position is not None:
                await device.set_capability_value('speaker_position', playing.position)

            # Volume (pyatv exposes volume on the audio interface, not Playing)
            if device.has_capability('volume_set') and self._atv is not None:
                try:
                    vol = self._atv.audio.volume
                    if vol is not None:
                        await device.set_capability_value('volume_set', vol / 100.0)
                except Exception:
                    pass

            # Media type
            if device.has_capability('media_type'):
                media_type_str = _MEDIA_TYPE_MAP.get(playing.media_type, 'unknown')

                # Check for podcast / audiobook sub-types via genre hint
                # pyatv does not expose MediaSubType directly, so use a best-effort check
                if playing.media_type == MediaType.Music and playing.genre:
                    genre_lower = playing.genre.lower()
                    if 'podcast' in genre_lower:
                        media_type_str = 'podcast'
                    elif 'audiobook' in genre_lower or 'audio book' in genre_lower:
                        media_type_str = 'audiobook'
                    else:
                        media_type_str = 'music'

                await device.set_capability_value('media_type', media_type_str)

            # Now-playing app (debounced)
            # pyatv 0.17: app info is on the Apps interface, not Playing
            app_obj = None
            if is_playing:
                try:
                    app_obj = self._atv.metadata.app
                except Exception:
                    pass
            await self._update_now_playing_app(
                app_obj.identifier if app_obj else None,
                app_obj.name if app_obj else None,
            )

            # Artwork — pyatv uses artwork_id to detect changes;
            # actual artwork is fetched via self._atv.metadata.artwork()
            if hasattr(playing, 'artwork_id') and playing.artwork_id:
                await self._update_artwork(playing.artwork_id)

        except Exception as err:
            device.error(f'Failed to update now playing info: {err}')

    async def _handle_powerstate(self, new_state: PowerState) -> None:
        device = self._device
        is_on = new_state == PowerState.On

        try:
            await device.set_capability_value('onoff', is_on)

            if device.has_capability('power'):
                power_label = device.homey.translate('capability.power.on' if is_on else 'capability.power.off') or ('On' if is_on else 'Off')
                await device.set_capability_value('power', power_label)
        except Exception as err:
            device.error(f'Failed to set power state: {err}')

        if not is_on:
            await self.clear_now_playing()

    async def _update_now_playing_app(
        self,
        bundle_id: str | None,
        display_name: str | None,
    ) -> None:
        """Debounced update of the now_playing_app capability.

        Guards against two livelock sources:
        1. Repeated updates for the same pending target cancel and recreate the
           debounce task, so it never fires. Fixed by tracking _pending_now_playing_app
           and short-circuiting if the incoming value matches it.
        2. Comparing against the persisted capability value (rather than the pending
           target) causes the debounce to restart on every position-tick update
           until the task finally fires and persists the value.
        """
        device = self._device

        if not device.has_capability('now_playing_app'):
            return

        target = display_name or ''

        # If a debounce task is already pending for this exact value, leave it alone.
        if self._pending_now_playing_app == target:
            return

        # Check the already-persisted capability — if it matches, nothing to do.
        current = device.get_capability_value('now_playing_app')
        if current == target:
            self._pending_now_playing_app = None
            return

        # App changed: track the pending target and start/restart debounce.
        self._pending_now_playing_app = target
        if self._now_playing_app_task and not self._now_playing_app_task.done():
            self._now_playing_app_task.cancel()

        async def _do_update() -> None:
            await asyncio.sleep(1.0)
            device.log(f'Now playing app changed: {bundle_id} / {display_name}')
            await device.set_capability_value('now_playing_app', target)
            self._pending_now_playing_app = None

            # Fire flow trigger (Apple TV only — checked by device subclass)
            await device.trigger_now_playing_app_changed(bundle_id or '-', display_name or '-')

        self._now_playing_app_task = asyncio.create_task(_do_update())

    async def _update_artwork(self, url: str) -> None:
        """Fetch and push album artwork to Homey."""
        if url == self._artwork_identifier:
            return

        # Do NOT set _artwork_identifier yet — only mark success after async ops
        # complete so a transient failure doesn't permanently deduplicate this URL
        # (Finding 3).
        device = self._device

        try:
            # Convert .heic to .jpg for compatibility
            artwork_url = url.replace('.heic', '.jpg')

            # Register the image with Homey's image API
            image = await device.homey.images.create_image()
            image.set_url(artwork_url)
            await image.update()
            await device.set_album_art_image(image)

            # Mark as processed only after all async operations succeed.
            self._artwork_identifier = url

            if device.has_capability('artwork_url'):
                from time import time
                cache_buster = int(time() * 1000)
                cloud_url = getattr(image, 'cloud_url', None)
                if cloud_url:
                    await device.set_capability_value(
                        'artwork_url',
                        f'{cloud_url}?v={cache_buster}',
                    )
                    # Only trigger the flow when we have an actual URL to deliver
                    # (Finding 6).
                    await device.trigger_artwork_url_updated(image)
        except Exception as err:
            device.error(f'Failed to update artwork: {err}')
