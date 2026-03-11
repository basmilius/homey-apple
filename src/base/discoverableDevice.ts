import type { DiscoveryResult } from '@basmilius/apple-common';
import { Device, type Driver } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import { convertDiscoveryResult, waitFor } from '../utils';
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
        const discovery = this.services[service];

        if (!discovery) {
            throw new Error(`Service ${service} not found`);
        }

        let result: Homey.DiscoveryResultMDNSSD | undefined;
        let retries = 0;
        const maxRetries = 10;

        while (retries < maxRetries) {
            const results = discovery.getDiscoveryResults();

            for (const [id, r] of Object.entries(results)) {
                if (id !== this.discoveryId) {
                    continue;
                }

                result = r as Homey.DiscoveryResultMDNSSD;
                break;
            }

            if (result) {
                break;
            }

            retries++;

            await waitFor(1000);
        }

        if (!result) {
            throw new Error(`Cannot find ${this.discoveryId} (${service}) on network.`);
        }

        const discoveryResult = convertDiscoveryResult(result as Homey.DiscoveryResultMDNSSD);
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
            // todo(Bas): translate.
            await this.setUnavailable(`Cannot find ${this.discoveryId} on network. You might need to pair with the device again.`);
        }
    }

    async onServiceFound(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        this.log('[discovery]', `Found ${this.discoveryId} on ${service} at ${discoveryResult.address}:${discoveryResult.service.port}`);
    }

    async onServiceUpdated(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        this.log('[discovery]', `Updated ${this.discoveryId}, now on on ${service} at ${discoveryResult.address}:${discoveryResult.service.port}`);
    }
}
