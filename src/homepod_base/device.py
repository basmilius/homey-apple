from __future__ import annotations

import asyncio
from typing import Any

from ..base.discoverable_device import DiscoverableDevice

CAPABILITIES = [
    'speaker_album',
    'speaker_artist',
    'speaker_duration',
    'speaker_next',
    'speaker_playing',
    'speaker_position',
    'speaker_prev',
    'speaker_stop',
    'speaker_track',
    'artwork_url',
    'artwork_url_local',
    'artwork_url_cloud',
    'volume_down',
    'volume_set',
    'volume_up',
    'button.restart',
    'button.repair',
]


class HomePodBaseDevice(DiscoverableDevice):
    """Homey device base class for HomePod and HomePod Mini."""

    @property
    def _device_capabilities(self) -> list[str]:
        return CAPABILITIES

    def _get_capability_handlers(self) -> dict[str, Any]:
        handlers = super()._get_capability_handlers()
        handlers['speaker_stop'] = self._on_speaker_stop
        return handlers

    # -- Speaker --

    async def _on_speaker_stop(self, _: Any, **__: Any) -> None:
        await self._require_atv().remote_control.stop()

    # ------------------------------------------------------------------
    # URL streaming
    # ------------------------------------------------------------------

    async def play_url(self, url: str, volume: float | None = None) -> None:
        """Stream a URL to the HomePod via AirPlay."""
        if self._atv is None:
            raise RuntimeError('Not connected.')

        if volume is not None:
            await self._atv.audio.set_volume(volume)

        from ..base.discoverable_device import _guarded_task
        _guarded_task(self._stream_url(url), self)

    async def _stream_url(self, url: str) -> None:
        atv = self._atv
        if atv is None:
            self.error('play_url failed: not connected')
            return

        try:
            await atv.stream.play_url(url)
        except Exception as err:
            self.error(f'play_url failed: {err}')
