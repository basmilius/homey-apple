import { Driver } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import HomePodBasePairing from './pairing';
import type Homey from 'homey';
import type HomePodBaseDevice from './device';

export default abstract class HomePodBaseDriver extends Driver<AppleApp> {
    abstract get modelFilter(): RegExp;

    async onInit(): Promise<void> {
        await this.#registerActions();
    }

    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        const pairing = new HomePodBasePairing(session, this.discovery.getStrategy('airplay'), this.modelFilter, this.getDevices());

        pairing.on('error', err => {
            // todo: Show error screen or something.
            this.error(err);
        });

        pairing.on('log', log => {
            this.log(log);
        });

        await pairing.start();
    }

    async #registerActions(): Promise<void> {
        await this.#registerPlayUrl();
        await this.#registerPlayUrlAtVolume();
    }

    async #registerPlayUrl(): Promise<void> {
        const playUrl = this.homey.flow.getActionCard('homepod_play_url');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly url: string;
        };

        playUrl.registerRunListener(async ({device, url}: RunArguments) => {
            await device.playUrl(url);
        });
    }

    async #registerPlayUrlAtVolume(): Promise<void> {
        const playUrl = this.homey.flow.getActionCard('homepod_play_url_at_volume');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly url: string;
            readonly volume: number;
        };

        playUrl.registerRunListener(async ({device, url, volume}: RunArguments) => {
            await device.playUrl(url, volume);
        });
    }
}
