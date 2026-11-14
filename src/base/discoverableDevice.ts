import type { DeviceTarget, LogEntry } from '@corewire/devices';
import { Device, type Driver } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import { extractMacAddress, toDeviceTarget, waitFor } from '../utils';
import type Homey from 'homey';

// Releases before 1.7.4 stored the MAC per service, under the full AirPlay service name.
const LEGACY_MAC_KEY = 'mac:_airplay._tcp.local';

// The Homey discovery cache may still be filling right after the app starts.
const STARTUP_BACKOFF = [500, 1000, 2000, 4000, 8000];

export default abstract class DiscoverableDevice<TDriver extends Driver<AppleApp>> extends Device<AppleApp, TDriver> {
    get discoveryId(): string {
        return this.getData().id;
    }

    abstract get discoveryStrategy(): Homey.DiscoveryStrategy;

    abstract onTargetFound(target: DeviceTarget): Promise<void>;

    async onInit(): Promise<void> {
        await super.onInit();
        await this.findTarget();
    }

    /**
     * Finds the device in the Homey discovery cache and hands it to {@link onTargetFound}, or marks
     * the device unavailable when it is not there.
     */
    async findTarget(): Promise<void> {
        const target = await this.#findWithBackoff();

        if (!target) {
            this.error('[discovery]', `Failed to find ${this.discoveryId} on network.`);
            await this.setUnavailable(`Cannot find ${this.discoveryId} on network. You might need to pair with the device again.`);
            return;
        }

        await this.#found(target);
        await this.onTargetFound(target);
    }

    /**
     * Looks the device up in the Homey discovery cache, by MAC and then by discovery id. The device
     * calls this before a retry when the unicast query at the last address found nothing.
     */
    async resolveTarget(): Promise<DeviceTarget | null> {
        const target = this.#lookup();

        if (target) {
            await this.#found(target);
        }

        return target;
    }

    /**
     * Writes a log entry of the device to the Homey log.
     */
    writeLogEntry(entry: LogEntry): void {
        if (entry.level === 'error') {
            this.error('[corewire]', entry.message);
        } else {
            this.log('[corewire]', entry.message);
        }
    }

    async #findWithBackoff(): Promise<DeviceTarget | null> {
        for (const delay of STARTUP_BACKOFF) {
            const target = this.#lookup();

            if (target) {
                return target;
            }

            await waitFor(delay);
        }

        return null;
    }

    async #found(target: DeviceTarget): Promise<void> {
        this.log('[discovery]', `Found ${this.discoveryId} at ${target.address}:${target.port}`);

        const mac = extractMacAddress(target.txt);

        if (!mac || this.getStoreValue('mac') === mac) {
            return;
        }

        await this.setStoreValue('mac', mac);
        this.log('[discovery]', `Stored MAC: ${mac}`);
    }

    #lookup(): DeviceTarget | null {
        const results = Object.entries(this.discoveryStrategy.getDiscoveryResults()) as [string, Homey.DiscoveryResultMDNSSD][];
        const storedMac = (this.getStoreValue('mac') ?? this.getStoreValue(LEGACY_MAC_KEY)) as string | null;

        const result = (storedMac ? results.find(([, entry]) => extractMacAddress(entry.txt as Record<string, string>) === storedMac) : undefined)
            ?? results.find(([id]) => id === this.discoveryId);

        return result ? toDeviceTarget(result[1]) : null;
    }
}
