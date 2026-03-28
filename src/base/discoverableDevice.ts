import { type DiscoveryResult, type MdnsService, mdnsUnicast } from '@basmilius/apple-sdk';
import { Device, type Driver } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import { convertDiscoveryResult, extractMacAddress, waitFor } from '../utils';
import type Homey from 'homey';

export default abstract class DiscoverableDevice<TDriver extends Driver<AppleApp>> extends Device<AppleApp, TDriver> {
    get discoveryId(): string {
        return this.getData().id;
    }

    get discoveryResults(): Record<string, DiscoveryResult> {
        return this.#discoveryResults;
    }

    abstract get services(): Record<string, Homey.DiscoveryStrategy>;

    #discoveryResults: Record<string, DiscoveryResult> = {};

    async onInit(): Promise<void> {
        await super.onInit();
        await this.findServices(false);
    }

    async findService(service: string, update: boolean = true): Promise<void> {
        const discoveryResult = update
            ? (await this.#findViaUnicast(service) ?? await this.#findViaHomey(service))
            : (await this.#findViaHomey(service) ?? await this.#findViaUnicast(service));

        if (!discoveryResult) {
            throw new Error(`Cannot find ${this.discoveryId} (${service}) on network.`);
        }

        this.#discoveryResults[service] = discoveryResult;

        this.log(`Found ${this.discoveryId} on ${service} at ${discoveryResult.address}:${discoveryResult.service.port}`);

        if (update) {
            await this.onServiceUpdated(service, discoveryResult);
        } else {
            await this.onServiceFound(service, discoveryResult);
        }
    }

    async findServices(update: boolean = true): Promise<void> {
        const results = await Promise.allSettled(
            Object
                .keys(this.services)
                .map(async service => this.findService(service, update))
        );

        const failed = results.filter(r => r.status === 'rejected');

        if (failed.length === results.length) {
            const err = (failed[0] as PromiseRejectedResult).reason;
            this.error('[discovery]', `Failed to find ${this.discoveryId} on network:`, err);
            await this.setUnavailable(`Cannot find ${this.discoveryId} on network. You might need to pair with the device again.`);
        } else if (failed.length > 0) {
            for (const f of failed) {
                this.error('[discovery]', `Partial discovery failure for ${this.discoveryId}:`, (f as PromiseRejectedResult).reason);
            }
        }
    }

    async onServiceFound(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        this.log('[discovery]', `Found ${this.discoveryId} on ${service} at ${discoveryResult.address}:${discoveryResult.service.port}`);
        await this.#migrateMacAddress(service, discoveryResult);
    }

    async onServiceUpdated(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        this.log('[discovery]', `Updated ${this.discoveryId} on ${service} at ${discoveryResult.address}:${discoveryResult.service.port}`);
        await this.#migrateMacAddress(service, discoveryResult);
    }

    async #findViaHomey(service: string): Promise<DiscoveryResult | null> {
        const discovery = this.services[service];

        if (!discovery) {
            return null;
        }

        const storedMac = this.getStoreValue(`mac:${service}`) as string | null;
        let result: Homey.DiscoveryResultMDNSSD | undefined;
        let retries = 0;

        while (retries < 5) {
            const results = discovery.getDiscoveryResults();
            const entries = Object.entries(results);

            // First pass: try to match by MAC address.
            if (storedMac) {
                for (const [, r] of entries) {
                    const mdnsResult = r as Homey.DiscoveryResultMDNSSD;
                    const mac = extractMacAddress(mdnsResult.txt as Record<string, string>);

                    if (mac === storedMac) {
                        result = mdnsResult;
                        break;
                    }
                }
            }

            // Second pass: fall back to discovery ID matching.
            if (!result) {
                for (const [id, r] of entries) {
                    if (id === this.discoveryId) {
                        result = r as Homey.DiscoveryResultMDNSSD;
                        break;
                    }
                }
            }

            if (result) {
                break;
            }

            retries++;
            await waitFor(1000);
        }

        return result ? convertDiscoveryResult(result, service) : null;
    }

    async #migrateMacAddress(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        const storeKey = `mac:${service}`;
        const mac = extractMacAddress(discoveryResult.txt as Record<string, string>);

        if (!mac || this.getStoreValue(storeKey) === mac) {
            return;
        }

        await this.setStoreValue(storeKey, mac);
        this.log('[discovery]', `Stored MAC for ${service}: ${mac}`);
    }

    async #findViaUnicast(service: string): Promise<DiscoveryResult | null> {
        const existing = this.#discoveryResults[service];

        if (!existing?.address) {
            return null;
        }

        this.log('[discovery]', `Homey mDNS cache miss for ${service}, trying unicast to ${existing.address}...`);

        const results = await mdnsUnicast([existing.address], [service], 5);
        const match = results.find((s: MdnsService) => s.address === existing.address);

        if (!match) {
            return null;
        }

        const txt = match.properties;
        const hostname = match.name.replace(/\s+/g, '-');

        return {
            id: `${hostname}.local`,
            fqdn: `${hostname}.local`,
            address: match.address,
            modelName: txt?.model ?? '',
            familyName: null,
            txt,
            service: {
                port: match.port,
                protocol: 'tcp',
                type: service
            },
            packet: null
        } as unknown as DiscoveryResult;
    }
}
