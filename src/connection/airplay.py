from __future__ import annotations

import asyncio

import pyatv
import pyatv.interface as pyatv_interface
from pyatv.const import Protocol


async def connect_with_credentials(
    config: pyatv_interface.BaseConfig,
    credentials: str | None,
) -> pyatv_interface.AppleTV:
    """
    Connect to a device using the given pyatv scan config and optional
    AirPlay credentials.

    Returns the connected :class:`pyatv.interface.AppleTV` instance.
    """
    if credentials:
        airplay_service = config.get_service(Protocol.AirPlay)
        if airplay_service is not None:
            airplay_service.credentials = credentials

    loop = asyncio.get_running_loop()
    return await pyatv.connect(config, loop)
