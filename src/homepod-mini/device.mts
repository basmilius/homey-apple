import { HomePodMini } from '@basmilius/apple-devices';
import type { DiscoveryResultMDNSSD } from 'homey';
import HomePodBaseDevice from '../homepod-base/device.mjs';

export default class HomePodMiniDevice extends HomePodBaseDevice {
    async createHomePodInstance(): Promise<HomePodMini> {
        const device = await this.#discover();

        return new HomePodMini({
            address: device.address,
            service: {
                port: device.port
            },
            packet: {
                additionals: [{
                    rdata: device.txt
                }]
            }
        });
    }

    async #discover(): Promise<DiscoveryResultMDNSSD> {
        const strategy = this.homey.discovery.getStrategy('homepod-mini');
        const result = strategy.getDiscoveryResult(this.getStore().id);

        return result as DiscoveryResultMDNSSD;
    }
}
