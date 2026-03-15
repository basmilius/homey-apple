"""Base class for devices discovered via Homey's mDNS discovery + pyatv."""

from __future__ import annotations

import asyncio
import logging
from abc import abstractmethod
from typing import TYPE_CHECKING

from homey.device import Device as HomeyDevice
from homey.discovery_result import DiscoveryResult
import pyatv

if TYPE_CHECKING:
    from pyatv.interface import BaseConfig

logger = logging.getLogger(__name__)

MAX_SCAN_RETRIES = 5
SCAN_RETRY_INTERVAL = 2.0  # seconds


class DiscoverableDevice(HomeyDevice):
    """Base device that uses Homey's built-in mDNS discovery to locate
    Apple devices, then connects via pyatv using a unicast scan."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._discovery_results: dict[str, BaseConfig] = {}
        self._discovery_address: str | None = None

    @property
    def discovery_id(self) -> str:
        """The mDNS/AirPlay identifier stored in device data."""
        return self.get_data().get('id', '')

    @property
    @abstractmethod
    def services(self) -> list[str]:
        """Return the list of service names this device needs."""

    # ------------------------------------------------------------------
    # Lifecycle — on_init no longer scans; we wait for discovery callbacks
    # ------------------------------------------------------------------

    async def on_init(self) -> None:
        await super().on_init()

    # ------------------------------------------------------------------
    # Homey SDK discovery callbacks
    # ------------------------------------------------------------------

    async def on_discovery_available(self, discovery_result: DiscoveryResult) -> None:
        """Called by the Homey SDK when our device is found on the network.

        If this method raises, the SDK marks the device as unavailable.
        If it returns normally, the SDK marks the device as available.
        """
        self._discovery_address = discovery_result.address
        self.log(f'Discovered at {self._discovery_address}')

        config = await self._scan_device(self._discovery_address)
        for service in self.services:
            self._discovery_results[service] = config

        await self._on_device_found(config)

    async def on_discovery_address_changed(self, discovery_result: DiscoveryResult) -> None:
        """Called by the Homey SDK when the device's IP address changes."""
        self._discovery_address = discovery_result.address
        self.log(f'Address changed to {self._discovery_address}')

    # ------------------------------------------------------------------
    # pyatv unicast scan
    # ------------------------------------------------------------------

    async def _scan_device(self, address: str) -> BaseConfig:
        """Unicast-scan the given IP to get its full pyatv config."""
        loop = asyncio.get_running_loop()

        for attempt in range(MAX_SCAN_RETRIES):
            try:
                results = await pyatv.scan(loop, timeout=5, hosts=[address])
                if results:
                    self.log(f'Scanned {address}: found {results[0].name}')
                    return results[0]
            except Exception as err:
                self.error(f'Scan attempt {attempt + 1} failed: {err}')

            if attempt < MAX_SCAN_RETRIES - 1:
                await asyncio.sleep(SCAN_RETRY_INTERVAL)

        raise RuntimeError(f'Cannot scan device at {address}')

    # ------------------------------------------------------------------
    # Hooks for subclasses
    # ------------------------------------------------------------------

    async def _on_device_found(self, config: BaseConfig) -> None:
        """Override in subclass to establish the pyatv connection."""

    # ------------------------------------------------------------------
    # Reconnection helper (used by subclass reconnect logic)
    # ------------------------------------------------------------------

    async def _reconnect(self) -> None:
        """Re-scan the last known address and reconnect."""
        if not self._discovery_address:
            raise RuntimeError('No known address for reconnection.')

        config = await self._scan_device(self._discovery_address)
        for service in self.services:
            self._discovery_results[service] = config

        await self._on_device_found(config)
        await self.set_available()
