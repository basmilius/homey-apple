from __future__ import annotations

import asyncio
import socket
from abc import abstractmethod
from typing import Any

import pyatv
from homey.device import Device

MAX_SCAN_RETRIES = 10
SCAN_RETRY_INTERVAL_S = 1.0
SCAN_TIMEOUT_S = 3


class DiscoverableDevice(Device):
    """
    A Homey device that discovers itself on the local network via
    ``pyatv.scan()``.

    Subclasses declare which services they need (via :attr:`services`) and
    receive a single pyatv ``BaseConfig`` containing all available protocols
    once scanning is complete.
    """

    @property
    def discovery_id(self) -> str:
        """The mDNS hostname stored in device data during pairing (e.g. ``Woonkamer-TV.local``)."""
        return self.get_data().get('id', '')

    @property
    def _expected_name(self) -> str:
        """Device name derived from the mDNS hostname (strip ``.local``, replace ``-`` with `` ``)."""
        return self.discovery_id.removesuffix('.local').replace('-', ' ')

    @property
    @abstractmethod
    def services(self) -> list[str]:
        """Logical service names this device needs (e.g. ``['airplay', 'companion-link']``)."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._scan_config: pyatv.interface.BaseConfig | None = None

    async def _resolve_host(self) -> str | None:
        """Resolve the mDNS hostname to an IPv4 address."""
        loop = asyncio.get_running_loop()
        hostname = self.discovery_id

        try:
            results = await loop.getaddrinfo(
                hostname,
                None,
                family=socket.AF_INET,
                type=socket.SOCK_STREAM,
            )
            if results:
                return results[0][4][0]
        except (socket.gaierror, OSError):
            pass

        return None

    def _match_scan_result(self, config: pyatv.interface.BaseConfig) -> bool:
        """Check if a pyatv scan result matches this device by name."""
        if not config.name:
            return False
        return config.name.lower() == self._expected_name.lower()

    async def scan(self) -> pyatv.interface.BaseConfig | None:
        """
        Scan for this device on the local network using pyatv, retrying
        up to :data:`MAX_SCAN_RETRIES` times.

        First attempts to resolve the mDNS hostname to an IP and scan that
        host directly.  If hostname resolution fails (e.g. in a sandboxed
        runtime without mDNS support), falls back to a broad network scan
        and matches by device name.

        Returns the first matching config, or *None* if not found.
        """
        loop = asyncio.get_running_loop()
        hostname = self.discovery_id

        for attempt in range(MAX_SCAN_RETRIES):
            # Fast path: resolve hostname to IP and scan directly.
            ip = await self._resolve_host()
            if ip is not None:
                results = await pyatv.scan(
                    loop,
                    timeout=SCAN_TIMEOUT_S,
                    hosts=[ip],
                )
                if results:
                    self._scan_config = results[0]
                    self.log(
                        f'Found {hostname} at '
                        f'{self._scan_config.address} (attempt {attempt + 1})'
                    )
                    return self._scan_config

            # Slow path: broad scan, match by name.
            results = await pyatv.scan(loop, timeout=SCAN_TIMEOUT_S)
            for config in results:
                if self._match_scan_result(config):
                    self._scan_config = config
                    self.log(
                        f'Found {hostname} at '
                        f'{config.address} via broad scan (attempt {attempt + 1})'
                    )
                    return self._scan_config

            if attempt < MAX_SCAN_RETRIES - 1:
                await asyncio.sleep(SCAN_RETRY_INTERVAL_S)

        self.error(f'Cannot find {hostname} on network after {MAX_SCAN_RETRIES} attempts.')
        return None

    async def remove_old_capabilities(self, current_capabilities: list[str]) -> None:
        """Remove any capabilities on the device that are not in *current_capabilities*."""
        for cap in list(self.get_capabilities()):
            if cap not in current_capabilities:
                try:
                    await self.remove_capability(cap)
                except Exception as err:
                    self.error(f'Failed to remove old capability {cap!r}:', err)
