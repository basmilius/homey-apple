from __future__ import annotations

import asyncio


async def wait_for(ms: int) -> None:
    """Wait for a given number of milliseconds."""
    await asyncio.sleep(ms / 1000)
