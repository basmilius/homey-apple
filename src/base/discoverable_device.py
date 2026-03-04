from __future__ import annotations

from typing import Any

from homey.device import Device
from homey.discovery_result_mdns_sd import DiscoveryResultMDNSSD

from ..utils.wait_for import wait_for

AIRPLAY_SERVICE = 'airplay'
COMPANION_LINK_SERVICE = 'companion-link'


class DiscoverableDevice(Device):
    """
    A Homey device that tracks mDNS-SD discovery results for one or more
    named services (e.g. ``airplay`` and ``companion-link``).

    Subclasses receive the discovery result via
    :meth:`on_discovery_available` (called by the Homey SDK for the primary
    service) and may also call :meth:`find_service` to look up additional
    services from ``self.homey.discovery``.
    """

    @property
    def discovery_id(self) -> str:
        return self.get_data().get('id', '')

    @property
    def discovery_results(self) -> dict[str, DiscoveryResultMDNSSD]:
        return self._discovery_results

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._discovery_results: dict[str, DiscoveryResultMDNSSD] = {}

    async def find_service(
        self, service: str, update: bool = True
    ) -> DiscoveryResultMDNSSD | None:
        """
        Look up the given discovery service by ID, retrying a few times.

        :param service: The discovery strategy ID (e.g. ``"companion-link"``).
        :param update: When *True*, call :meth:`on_service_updated`; otherwise
                       call :meth:`on_service_found`.
        :returns: The :class:`DiscoveryResultMDNSSD`, or *None* on failure.
        """
        try:
            strategy = self.homey.discovery.get_strategy(service)
        except Exception:
            self.error(f'Discovery strategy {service!r} not found')
            return None

        result: DiscoveryResultMDNSSD | None = None
        max_retries = 3

        for _ in range(max_retries):
            results = strategy.get_discovery_results()
            result = results.get(self.discovery_id)  # type: ignore[assignment]
            if result is not None:
                break
            await wait_for(500)

        if result is None:
            raise RuntimeError(
                f'Cannot find {self.discovery_id!r} ({service}) on network.'
            )

        self._discovery_results[service] = result

        self.log(
            f'Found {self.discovery_id} on {service} at {result.address}:{result.port}'
        )

        if update:
            await self.on_service_updated(service, result)
        else:
            await self.on_service_found(service, result)

        return result

    async def on_service_found(
        self, service: str, discovery_result: DiscoveryResultMDNSSD
    ) -> None:
        self.log(
            '[discovery]',
            f'Found {self.discovery_id} on {service} at {discovery_result.address}:{discovery_result.port}',
        )

    async def on_service_updated(
        self, service: str, discovery_result: DiscoveryResultMDNSSD
    ) -> None:
        self.log(
            '[discovery]',
            f'Updated {self.discovery_id}, now on {service} at {discovery_result.address}:{discovery_result.port}',
        )

    async def on_discovery_result(self, discovery_result: DiscoveryResultMDNSSD) -> bool:
        """Match discovery results by comparing the device data ID."""
        own_id = self.get_data().get('id')
        if isinstance(discovery_result.id, str) and isinstance(own_id, str):
            return discovery_result.id == own_id
        return False

    async def remove_old_capabilities(self, current_capabilities: list[str]) -> None:
        """Remove any capabilities on the device that are not in *current_capabilities*."""
        for cap in list(self.get_capabilities()):
            if cap not in current_capabilities:
                try:
                    await self.remove_capability(cap)
                except Exception as err:
                    self.error(f'Failed to remove old capability {cap!r}:', err)
