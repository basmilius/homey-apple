import { type DiscoveryResult, mdnsUnicast, type MdnsService } from '@basmilius/apple-common';
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
        const discoveryResult = await this.#findViaHomey(service)
            ?? await this.#findViaUnicast(service);

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
        try {
            await Promise.all(
                Object
                    .keys(this.services)
                    .map(async service => this.findService(service, update))
            );
        } catch (err) {
            this.error('[discovery]', `Failed to find ${this.discoveryId} on network:`, err);
            await this.setUnavailable(`Cannot find ${this.discoveryId} on network. You might need to pair with the device again.`);
        }
    }

    async onServiceFound(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        this.log('[discovery]', `Found ${this.discoveryId} on ${service} at ${discoveryResult.address}:${discoveryResult.service.port}`);
        await this.#migrateMacAddress(discoveryResult);
    }

    async onServiceUpdated(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        this.log('[discovery]', `Updated ${this.discoveryId} on ${service} at ${discoveryResult.address}:${discoveryResult.service.port}`);
        await this.#migrateMacAddress(discoveryResult);
    }

    async #findViaHomey(service: string): Promise<DiscoveryResult | null> {
        const discovery = this.services[service];

        if (!discovery) {
            return null;
        }

        const storedMac = this.getStoreValue('mac') as string | null;
        let result: Homey.DiscoveryResultMDNSSD | undefined;
        let retries = 0;

        while (retries < 5) {
            const results = discovery.getDiscoveryResults();

            for (const [id, r] of Object.entries(results)) {
                const mdnsResult = r as Homey.DiscoveryResultMDNSSD;

                if (storedMac) {
                    const mac = extractMacAddress(mdnsResult.txt as Record<string, string>);

                    if (mac === storedMac) {
                        result = mdnsResult;
                        break;
                    }
                }

                if (id === this.discoveryId) {
                    result = mdnsResult;
                    break;
                }
            }

            if (result) {
                break;
            }

            retries++;
            await waitFor(1000);
        }

        return result ? convertDiscoveryResult(result) : null;
    }

    async #migrateMacAddress(discoveryResult: DiscoveryResult): Promise<void> {
        if (this.getStoreValue('mac')) {
            return;
        }

        const mac = extractMacAddress(discoveryResult.txt as Record<string, string>);

        if (!mac) {
            return;
        }

        await this.setStoreValue('mac', mac);
        this.log('[discovery]', `Migrated device to MAC-based identification: ${mac}`);
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
