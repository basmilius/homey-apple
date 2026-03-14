"""Base class for devices discovered via mDNS/zeroconf using pyatv."""

from __future__ import annotations

import asyncio
import logging
from abc import abstractmethod
from typing import TYPE_CHECKING

import homey
import pyatv

if TYPE_CHECKING:
    from pyatv.interface import BaseConfig

logger = logging.getLogger(__name__)

MAX_FIND_RETRIES = 10
FIND_RETRY_INTERVAL = 1.0  # seconds


class DiscoverableDevice(homey.Device):
    """Base device that locates itself on the LAN via pyatv.scan()."""

    def __init__(self):
        super().__init__()
        # Map of service name -> resolved pyatv config
        self._discovery_results: dict[str, BaseConfig] = {}

    @property
    def discovery_id(self) -> str:
        """The mDNS/AirPlay identifier stored in device data."""
        return self.get_data().get('id', '')

    @property
    @abstractmethod
    def services(self) -> list[str]:
        """Return the list of service names this device needs to resolve.

        Each entry is a pyatv Protocol name or a logical service key that
        subclasses map to the right pyatv scan call.
        """

    async def on_init(self) -> None:
        await super().on_init()
        await self._find_services(update=False)

    async def find_service(self, service: str, update: bool = True) -> None:
        """Scan for this device on the given service, retrying up to MAX_FIND_RETRIES times."""
        loop = asyncio.get_running_loop()
        config: BaseConfig | None = None

        for attempt in range(MAX_FIND_RETRIES):
            results = await pyatv.scan(loop, timeout=3, identifier=self.discovery_id)

            if results:
                config = results[0]
                break

            if attempt < MAX_FIND_RETRIES - 1:
                await asyncio.sleep(FIND_RETRY_INTERVAL)

        if config is None:
            raise RuntimeError(
                f'Cannot find {self.discovery_id} ({service}) on network.'
            )

        self._discovery_results[service] = config
        self.log(f'Found {self.discovery_id} on {service} at {config.address}')

        if update:
            await self.on_service_updated(service, config)
        else:
            await self.on_service_found(service, config)

    async def _find_services(self, update: bool = True) -> None:
        """Find all required services concurrently.

        Uses return_exceptions=True so that a failure on one service does not
        cancel scans that are still in progress for other services (Finding 7).
        """
        results = await asyncio.gather(
            *[self.find_service(svc, update) for svc in self.services],
            return_exceptions=True,
        )
        errors = [r for r in results if isinstance(r, BaseException)]
        if errors:
            await self.set_unavailable(
                f'Cannot find {self.discovery_id} on network. '
                'You might need to pair with the device again.'
            )
            for err in errors:
                self.error(f'Failed to find service: {err}')

    async def on_service_found(self, service: str, config: BaseConfig) -> None:
        """Called when a service is found for the first time."""
        self.log(f'[discovery] Found {self.discovery_id} on {service} at {config.address}')

    async def on_service_updated(self, service: str, config: BaseConfig) -> None:
        """Called when a previously found service has updated discovery info."""
        self.log(f'[discovery] Updated {self.discovery_id} on {service} at {config.address}')
