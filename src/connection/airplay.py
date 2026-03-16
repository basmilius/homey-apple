from __future__ import annotations

import asyncio

import pyatv
import pyatv.interface as pyatv_interface
from pyatv.const import Protocol


async def connect_with_storage(
    config: pyatv_interface.BaseConfig,
    storage: pyatv_interface.Storage,
) -> pyatv_interface.AppleTV:
    """
    Connect to a device using pyatv's storage-managed credentials.

    The storage backend handles all credential lookup and persistence
    automatically.

    Returns the connected :class:`pyatv.interface.AppleTV` instance.
    """
    loop = asyncio.get_running_loop()
    return await pyatv.connect(config, loop, storage=storage)


async def connect_with_credentials(
    config: pyatv_interface.BaseConfig,
    airplay_credentials: str | None = None,
    companion_credentials: str | None = None,
) -> pyatv_interface.AppleTV:
    """
    Connect to a device using the given pyatv scan config and optional
    protocol credentials.

    The same credentials can be used for both AirPlay and Companion
    protocols.  When only *airplay_credentials* is provided, it is also
    applied to the Companion service so that power control and remote
    commands work without a separate pairing step.

    This is a fallback for devices without storage credentials.

    Returns the connected :class:`pyatv.interface.AppleTV` instance.
    """
    if airplay_credentials:
        airplay_service = config.get_service(Protocol.AirPlay)
        if airplay_service is not None:
            airplay_service.credentials = airplay_credentials

        # Use AirPlay credentials for Companion as well, unless
        # separate Companion credentials are provided.
        if companion_credentials is None:
            companion_service = config.get_service(Protocol.Companion)
            if companion_service is not None:
                companion_service.credentials = airplay_credentials

    if companion_credentials:
        companion_service = config.get_service(Protocol.Companion)
        if companion_service is not None:
            companion_service.credentials = companion_credentials

    loop = asyncio.get_running_loop()
    return await pyatv.connect(config, loop)
