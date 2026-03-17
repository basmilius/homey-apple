from __future__ import annotations

import asyncio
import socket
from abc import abstractmethod
from typing import Any

import pyatv
import pyatv.exceptions as pyatv_exceptions
import pyatv.interface as pyatv_interface
from homey.device import Device

from ..connection.airplay import connect_with_credentials, connect_with_storage
from ..logic.airplay import AirPlayLogic
from ..utils.get_credentials_from_device import get_credentials_from_device
from ..utils.mac_address import extract_mac_from_txt, is_mac_format

MAX_SCAN_RETRIES = 10
SCAN_RETRY_INTERVAL_S = 1.0
SCAN_TIMEOUT_S = 3
DNS_RESOLVE_TIMEOUT_S = 5.0
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
        """The mDNS hostname or MAC address stored in device data during pairing."""
        return self.get_data().get('id', '')

    @property
    def device_mac(self) -> str | None:
        """The MAC address of this device, from data ID or store."""
        data_id = self.get_data().get('id', '')
        if is_mac_format(data_id):
            return data_id

        store = self.get_store()
        mac = store.get('mac')
        if mac and isinstance(mac, str) and is_mac_format(mac):
            return mac

        return None

    @property
    def is_legacy_device(self) -> bool:
        """True if this device was paired with a hostname ID instead of a MAC address."""
        return not is_mac_format(self.get_data().get('id', ''))

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
        task = self._initial_connect_task
        self._initial_connect_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

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
        """Connect to the device using a pyatv config.

        Prefers storage-based connection (credentials managed by pyatv).
        Falls back to manual credential injection for devices without
        storage credentials. Migrates legacy credentials into storage
        on first connect.
        """
        from ..app import AppleApp
        app = AppleApp._instance
        storage = app.storage if app is not None else None

        # Migrate legacy credentials into storage on first connect.
        await self._migrate_credentials_to_storage(config, storage)

        for attempt in range(MAX_CONNECT_RETRIES):
            try:
                if storage is not None:
                    atv = await connect_with_storage(config, storage)
                else:
                    credentials = get_credentials_from_device(self)
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

    async def _migrate_credentials_to_storage(
        self,
        config: pyatv_interface.BaseConfig,
        storage: Any,
    ) -> None:
        """Migrate legacy credentials from the device store into pyatv storage.

        This is a one-time operation per device. After migration, pyatv
        manages credentials automatically via the storage backend.
        """
        if storage is None:
            return

        from pyatv.const import Protocol

        credentials = get_credentials_from_device(self)
        airplay_cred = credentials.get('airplay')
        companion_cred = credentials.get('companion')

        if not airplay_cred and not companion_cred:
            return

        # Check if storage already has settings for this device.
        has_airplay = False
        has_companion = False
        try:
            settings = await storage.get_settings(config)
            has_airplay = bool(settings.protocols.airplay.credentials)
            has_companion = bool(settings.protocols.companion.credentials)
        except Exception:
            pass

        # Skip only if everything we could migrate is already present.
        if (not airplay_cred or has_airplay) and (not companion_cred or has_companion):
            return

        self.log('Migrating legacy credentials to pyatv storage...')

        # Apply credentials to config services so update_settings can pick them up.
        if airplay_cred and not has_airplay:
            airplay_service = config.get_service(Protocol.AirPlay)
            if airplay_service is not None:
                airplay_service.credentials = airplay_cred

        if companion_cred and not has_companion:
            companion_service = config.get_service(Protocol.Companion)
            if companion_service is not None:
                companion_service.credentials = companion_cred

        try:
            await storage.update_settings(config)
            await storage.save()
            self.log('Credentials migrated to pyatv storage.')
        except Exception as err:
            self.error('Failed to migrate credentials to storage:', err)

    async def _on_connected(self) -> None:
        """Hook called after successful connection. Override for post-connect behavior."""

    async def _sync_initial_volume(self) -> None:
        """Sync the current volume from the device after connecting."""
        if self._atv is None or not self.has_capability('volume_set'):
            return

        try:
            volume = self._atv.audio.volume
            if volume is not None:
                clamped = max(0.0, min(100.0, float(volume)))
                await self.set_capability_value('volume_set', clamped / 100.0)
                self.log(f'Initial volume synced: {clamped}%')
        except Exception as err:
            self.log('Failed to sync initial volume:', err)

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
            results = await asyncio.wait_for(
                loop.getaddrinfo(
                    hostname,
                    None,
                    family=socket.AF_INET,
                    type=socket.SOCK_STREAM,
                ),
                timeout=DNS_RESOLVE_TIMEOUT_S,
            )
            if results:
                return results[0][4][0]
        except (socket.gaierror, OSError, asyncio.TimeoutError):
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

        Uses MAC-based scanning when a MAC address is available (preferred),
        falling back to hostname-based scanning for legacy devices.

        After a successful scan, extracts and stores the MAC address for
        future use.

        Returns the first matching config, or *None* if not found.
        """
        from ..app import AppleApp
        app = AppleApp._instance
        storage = app.storage if app is not None else None

        loop = asyncio.get_running_loop()
        mac = self.device_mac
        device_label = mac or self.discovery_id

        for attempt in range(MAX_SCAN_RETRIES):
            config: pyatv_interface.BaseConfig | None = None

            # Primary path: scan by MAC address via pyatv identifier.
            if mac is not None:
                results = await pyatv.scan(
                    loop,
                    timeout=SCAN_TIMEOUT_S,
                    identifier=mac,
                    storage=storage,
                )
                if results:
                    config = results[0]

            # Fallback for legacy devices: resolve hostname → scan by IP.
            if config is None and self.is_legacy_device:
                ip = await self._resolve_host()
                if ip is not None:
                    config = await self._scan_by_host(ip)

                # Broad scan fallback.
                if config is None:
                    results = await pyatv.scan(loop, timeout=SCAN_TIMEOUT_S)
                    for result in results:
                        if self._match_scan_result(result):
                            self.log(
                                f'Found {device_label} at {result.address} via broad scan, '
                                f'performing targeted scan for full protocol discovery...'
                            )
                            config = await self._scan_by_host(str(result.address))
                            break

            if config is not None:
                self.log(
                    f'Found {device_label} at '
                    f'{config.address} (attempt {attempt + 1})'
                )
                await self._store_mac_from_config(config)
                return config

            if attempt < MAX_SCAN_RETRIES - 1:
                await asyncio.sleep(SCAN_RETRY_INTERVAL_S)

        self.error(f'Cannot find {device_label} on network after {MAX_SCAN_RETRIES} attempts.')
        return None

    async def _store_mac_from_config(self, config: pyatv_interface.BaseConfig) -> None:
        """Extract a MAC address from the scan result and persist it in the device store."""
        if self.device_mac is not None:
            return

        # Try to extract MAC from service properties (TXT records).
        for service in config.services:
            props = service.properties
            if props:
                mac = extract_mac_from_txt(props)
                if mac:
                    await self.set_store_value('mac', mac)
                    self.log(f'Stored MAC address {mac} for future scans.')
                    return

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
            self.log('Restart requested but reconnect already in progress, skipping.')
            return

        async with self._reconnect_lock:
            try:
                await self.set_unavailable('Restarting...')
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
                self.error('Restart failed:', err)

    async def _on_repair(self, _: Any, **__: Any) -> None:
        self._is_repair_requested = True
        await self._disconnect()
        if self._airplay_logic is not None:
            await self._airplay_logic.clear_now_playing()
        await self.set_unavailable(
            'Device marked for re-pairing. Please remove and re-add this device.'
        )
