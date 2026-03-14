from __future__ import annotations

import asyncio
import socket
from abc import abstractmethod
from typing import Any

import pyatv
import pyatv.exceptions as pyatv_exceptions
import pyatv.interface as pyatv_interface
from homey.device import Device

from ..connection.airplay import connect_with_credentials
from ..logic.airplay import AirPlayLogic
from ..utils.get_credentials_from_device import get_credentials_from_device

MAX_SCAN_RETRIES = 10
SCAN_RETRY_INTERVAL_S = 1.0
SCAN_TIMEOUT_S = 3
RECONNECT_DELAY_S = 1.0
SCHEDULED_RECONNECT_INTERVAL_S = 5 * 60
MAX_CONNECT_RETRIES = 3
CONNECT_RETRY_DELAY_S = 3.0


def _guarded_task(coro: Any, device: Any) -> asyncio.Task:
    """Create a task that logs exceptions instead of leaving them unhandled."""
    task = asyncio.create_task(coro)
    task.add_done_callback(lambda t: _on_task_done(t, device))
    return task


def _on_task_done(task: asyncio.Task, device: Any) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        try:
            device.error('Unhandled task exception:', exc)
        except Exception:
            pass


class DiscoverableDevice(Device):
    """
    A Homey device that discovers itself on the local network via
    ``pyatv.scan()``, connects, and manages the connection lifecycle.

    Subclasses provide their capabilities list, device type name, and
    capability handlers via abstract properties and hook methods.
    """

    @property
    def atv(self) -> pyatv_interface.AppleTV | None:
        """The underlying pyatv AppleTV interface, or None if not connected."""
        return self._atv

    @property
    def airplay_logic(self) -> AirPlayLogic | None:
        """The AirPlay logic instance, or None before initialization."""
        return self._airplay_logic

    @property
    def discovery_id(self) -> str:
        """The mDNS hostname stored in device data during pairing."""
        return self.get_data().get('id', '')

    @property
    def _expected_name(self) -> str:
        """Device name derived from the mDNS hostname."""
        return self.discovery_id.removesuffix('.local').replace('-', ' ')

    @property
    @abstractmethod
    def _device_capabilities(self) -> list[str]:
        """List of Homey capabilities for this device type."""

    @property
    @abstractmethod
    def _device_type_name(self) -> str:
        """Human-readable device type name for log messages."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._atv: pyatv_interface.AppleTV | None = None
        self._airplay_logic: AirPlayLogic | None = None
        self._connected_once = False
        self._is_closing = False
        self._is_repair_requested = False
        self._reconnect_lock = asyncio.Lock()
        self._initial_connect_task: asyncio.Task | None = None
        self._scheduled_reconnect_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def on_init(self) -> None:
        await self.set_unavailable('Connecting...')

        from ..app import AppleApp
        app = AppleApp._instance
        if app is None:
            raise RuntimeError('AppleApp is not initialized yet; cannot initialize device.')

        self._airplay_logic = AirPlayLogic(self, app)
        await self._airplay_logic.initialize()

        await self.sync_capabilities(self._device_capabilities)
        self._register_capabilities()

        self._initial_connect_task = _guarded_task(self._initial_connect(), self)

        self.log('Initialized.')

    async def on_uninit(self) -> None:
        if self._initial_connect_task is not None and not self._initial_connect_task.done():
            self._initial_connect_task.cancel()
            try:
                await self._initial_connect_task
            except (asyncio.CancelledError, Exception):
                pass
            self._initial_connect_task = None

        if self._airplay_logic is not None:
            await self._airplay_logic.uninitialize()
        await self._disconnect()
        self.log('Uninitialized.')

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    async def _initial_connect(self) -> None:
        """Scan for the device and connect."""
        config = await self.scan()
        if config is None:
            await self.set_unavailable(
                'Cannot find device on network. You might need to re-pair.'
            )
            await self._start_scheduled_reconnect()
            return

        await self._connect(config)

        # If _connect() failed (e.g. protocol error), self._atv is still None.
        # Schedule periodic retries so the device recovers without manual intervention.
        if self._atv is None:
            await self._start_scheduled_reconnect()

    async def _connect(self, config: pyatv_interface.BaseConfig) -> None:
        """Connect to the device using a pyatv config."""
        credentials = get_credentials_from_device(self)

        for attempt in range(MAX_CONNECT_RETRIES):
            try:
                atv = await connect_with_credentials(
                    config,
                    airplay_credentials=credentials.get('airplay'),
                    companion_credentials=credentials.get('companion'),
                )
                try:
                    atv.listener = self
                    if self._airplay_logic is not None:
                        self._airplay_logic.set_atv(atv)
                    self._atv = atv
                    self._connected_once = True

                    await self._on_connected()

                    await self._start_scheduled_reconnect()
                    await self.set_available()
                    self.log(f'Connected to {self._device_type_name}.')
                    return
                except BaseException:
                    atv.listener = None
                    atv.close()
                    raise
            except pyatv_exceptions.ProtocolError as err:
                if attempt < MAX_CONNECT_RETRIES - 1:
                    self.log(
                        f'Connection attempt {attempt + 1}/{MAX_CONNECT_RETRIES} failed '
                        f'({err}), retrying in {CONNECT_RETRY_DELAY_S}s...'
                    )
                    await asyncio.sleep(CONNECT_RETRY_DELAY_S)
                else:
                    self.error(f'Failed to connect to {self._device_type_name} after {MAX_CONNECT_RETRIES} attempts:', err)
                    await self.set_unavailable(f'Cannot connect to {self._device_type_name}: {err}')
            except Exception as err:
                self.error(f'Failed to connect to {self._device_type_name}:', err)
                await self.set_unavailable(f'Cannot connect to {self._device_type_name}: {err}')
                return

    async def _on_connected(self) -> None:
        """Hook called after successful connection. Override for post-connect behavior."""

    async def _disconnect(self) -> None:
        """Disconnect and clean up."""
        await self._stop_scheduled_reconnect()
        if self._airplay_logic is not None:
            self._airplay_logic.stop()
        if self._atv is not None:
            self._is_closing = True
            try:
                self._atv.close()
            finally:
                self._atv = None
                self._is_closing = False

    async def _reconnect(self) -> None:
        """Disconnect, re-scan, and reconnect."""
        await self._disconnect()

        config = await self.scan()
        if config is None:
            await self.set_unavailable(
                'Cannot find device on network after reconnect attempt.'
            )
            await self._start_scheduled_reconnect()
            return

        await self._connect(config)

        # If _connect() failed (e.g. protocol error), self._atv is still None.
        # Schedule periodic retries so the device recovers without manual intervention.
        if self._atv is None:
            await self._start_scheduled_reconnect()

    # ------------------------------------------------------------------
    # pyatv DeviceListener
    # ------------------------------------------------------------------

    def connection_lost(self, exception: Exception) -> None:
        self.log('Connection lost:', exception)
        if not self._is_closing:
            _guarded_task(self._on_disconnected(), self)

    def connection_closed(self) -> None:
        self.log('Connection closed.')
        if not self._is_closing:
            _guarded_task(self._on_disconnected(), self)

    async def _on_disconnected(self) -> None:
        """Handle unexpected disconnection with reconnect guard."""
        if self._reconnect_lock.locked() or self._is_repair_requested:
            return

        async with self._reconnect_lock:
            try:
                self.log(f'Disconnected from {self._device_type_name}, reconnecting...')
                await self.set_unavailable(f'Disconnected from {self._device_type_name}, reconnecting...')
                await asyncio.sleep(RECONNECT_DELAY_S)
                await self._reconnect()
            except Exception as err:
                self.error('Reconnect after disconnection failed:', err)
                await self._start_scheduled_reconnect()

    # ------------------------------------------------------------------
    # Scheduled reconnect (handles port changes)
    # ------------------------------------------------------------------

    async def _start_scheduled_reconnect(self) -> None:
        # When called from within the loop itself (during a scheduled reconnect),
        # do nothing — the while-loop will naturally continue after _reconnect() returns.
        if self._scheduled_reconnect_task is asyncio.current_task():
            return

        await self._stop_scheduled_reconnect()
        self._scheduled_reconnect_task = _guarded_task(self._scheduled_reconnect_loop(), self)

    async def _stop_scheduled_reconnect(self) -> None:
        # Never cancel the task that is currently executing this code — that would
        # cancel the scheduled reconnect loop from within itself.
        task = self._scheduled_reconnect_task
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            self._scheduled_reconnect_task = None
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    async def _scheduled_reconnect_loop(self) -> None:
        """Periodically reconnect to pick up port changes."""
        while True:
            await asyncio.sleep(SCHEDULED_RECONNECT_INTERVAL_S)

            if self._reconnect_lock.locked() or self._is_repair_requested:
                continue

            async with self._reconnect_lock:
                try:
                    self.log('Scheduled reconnection, re-scanning...')
                    await self._reconnect()
                except Exception as err:
                    self.error('Scheduled reconnect failed:', err)

    # ------------------------------------------------------------------
    # Network discovery
    # ------------------------------------------------------------------

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

    def _match_scan_result(self, config: pyatv_interface.BaseConfig) -> bool:
        """Check if a pyatv scan result matches this device by name or identifier."""
        hostname = self.discovery_id.removesuffix('.local')

        if config.name and config.name.lower() == self._expected_name.lower():
            return True

        if config.identifier and hostname.lower() in config.identifier.lower():
            return True

        return False

    async def _scan_by_host(self, ip: str) -> pyatv_interface.BaseConfig | None:
        """Targeted unicast scan of a specific IP — discovers all protocols."""
        loop = asyncio.get_running_loop()
        results = await pyatv.scan(loop, timeout=SCAN_TIMEOUT_S, hosts=[ip])
        return results[0] if results else None

    async def scan(self) -> pyatv_interface.BaseConfig | None:
        """
        Scan for this device on the local network using pyatv, retrying
        up to :data:`MAX_SCAN_RETRIES` times.

        First attempts to resolve the mDNS hostname to an IP and scan that
        host directly.  If hostname resolution fails, falls back to a broad
        network scan to find the device by name, then does a targeted
        follow-up scan on the discovered IP to ensure all protocols are found.

        Returns the first matching config, or *None* if not found.
        """
        loop = asyncio.get_running_loop()
        hostname = self.discovery_id

        for attempt in range(MAX_SCAN_RETRIES):
            # Fast path: resolve hostname to IP and scan directly.
            ip = await self._resolve_host()
            if ip is not None:
                config = await self._scan_by_host(ip)
                if config is not None:
                    self.log(
                        f'Found {hostname} at '
                        f'{config.address} (attempt {attempt + 1})'
                    )
                    return config

            # Slow path: broad scan to find the device IP by name, then do
            # a targeted scan on that IP for complete protocol discovery.
            results = await pyatv.scan(loop, timeout=SCAN_TIMEOUT_S)
            for result in results:
                if self._match_scan_result(result):
                    self.log(
                        f'Found {hostname} at {result.address} via broad scan, '
                        f'performing targeted scan for full protocol discovery...'
                    )
                    config = await self._scan_by_host(str(result.address))
                    if config is not None:
                        self.log(
                            f'Found {hostname} at '
                            f'{config.address} (attempt {attempt + 1})'
                        )
                        return config

            if attempt < MAX_SCAN_RETRIES - 1:
                await asyncio.sleep(SCAN_RETRY_INTERVAL_S)

        self.error(f'Cannot find {hostname} on network after {MAX_SCAN_RETRIES} attempts.')
        return None

    async def sync_capabilities(self, expected: list[str]) -> None:
        """Add missing and remove stale capabilities to match *expected*."""
        current = self.get_capabilities()
        expected_set = set(expected)
        current_set = set(current)

        for cap in expected:
            if cap not in current_set:
                try:
                    await self.add_capability(cap)
                except Exception as err:
                    self.error(f'Failed to add capability {cap!r}:', err)

        for cap in current:
            if cap not in expected_set:
                try:
                    await self.remove_capability(cap)
                except Exception as err:
                    self.error(f'Failed to remove capability {cap!r}:', err)

    # ------------------------------------------------------------------
    # Capability handlers (shared)
    # ------------------------------------------------------------------

    def _register_capabilities(self) -> None:
        """Register capability listeners from the handler map."""
        current = self.get_capabilities()
        for cap, handler in self._get_capability_handlers().items():
            if cap in current:
                self.register_capability_listener(cap, handler)

    def _get_capability_handlers(self) -> dict[str, Any]:
        """Return a mapping of capability names to handler methods. Override to extend."""
        return {
            'speaker_next': self._on_speaker_next,
            'speaker_prev': self._on_speaker_prev,
            'speaker_playing': self._on_speaker_playing,
            'volume_up': self._on_volume_up,
            'volume_down': self._on_volume_down,
            'volume_set': self._on_volume_set,
            'button.restart': self._on_restart,
            'button.repair': self._on_repair,
        }

    def _require_atv(self) -> pyatv_interface.AppleTV:
        """Return the active pyatv connection or raise if not connected."""
        if self._atv is None:
            raise RuntimeError(f'{self._device_type_name} is not connected.')
        return self._atv

    async def _on_speaker_next(self, _: Any, **__: Any) -> None:
        await self._require_atv().remote_control.next()

    async def _on_speaker_prev(self, _: Any, **__: Any) -> None:
        await self._require_atv().remote_control.previous()

    async def _on_speaker_playing(self, play: bool, **_: Any) -> None:
        atv = self._require_atv()
        if play:
            await atv.remote_control.play()
        else:
            await atv.remote_control.pause()

    async def _on_volume_up(self, _: Any, **__: Any) -> None:
        await self._require_atv().audio.volume_up()

    async def _on_volume_down(self, _: Any, **__: Any) -> None:
        await self._require_atv().audio.volume_down()

    async def _on_volume_set(self, volume: float, **_: Any) -> None:
        await self._require_atv().audio.set_volume(volume * 100)

    async def _on_restart(self, _: Any, **__: Any) -> None:
        if self._reconnect_lock.locked():
            return

        async with self._reconnect_lock:
            try:
                await self._disconnect()
                if self._airplay_logic is not None:
                    await self._airplay_logic.clear_now_playing()
                config = await self.scan()
                if config is None:
                    await self.set_unavailable(
                        'Cannot find device on network after restart attempt.'
                    )
                    await self._start_scheduled_reconnect()
                else:
                    await self._connect(config)
                    if self._atv is None:
                        await self._start_scheduled_reconnect()
            except Exception as err:
                self.error(err)

    async def _on_repair(self, _: Any, **__: Any) -> None:
        self._is_repair_requested = True
        await self._disconnect()
        if self._airplay_logic is not None:
            await self._airplay_logic.clear_now_playing()
        await self.set_unavailable(
            'Device marked for re-pairing. Please remove and re-add this device.'
        )
