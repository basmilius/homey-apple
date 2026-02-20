import { Shortcuts } from '@basmilius/homey-common';
import type { AppleApp, HomePodBaseDevice, HomePodBaseDriver } from '../types';

export default class HomePodFlow extends Shortcuts<AppleApp> {
    register(): void {
        this.#registerPlayUrl();
        this.#registerPlayUrlAtVolume();
    }

    async triggerArtworkUrlUpdated(device: HomePodBaseDevice<HomePodBaseDriver>, localUrl: string, cloudUrl: string): Promise<void> {
        const triggerCard = this.flow.getDeviceTriggerCard('homepod_artwork_url_updated');

        await triggerCard.trigger(device, {
            localUrl,
            cloudUrl
        });
    }

    #registerPlayUrl(): void {
        const playUrl = this.homey.flow.getActionCard('homepod_play_url');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly url: string;
        };

        playUrl.registerRunListener(async ({device, url}: RunArguments) => {
            await device.playUrl(url);
        });
    }

    #registerPlayUrlAtVolume(): void {
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
