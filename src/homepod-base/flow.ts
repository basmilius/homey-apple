import { Shortcuts } from '@basmilius/homey-common';
import type { AppleApp, HomePodBaseDevice, HomePodBaseDriver } from '../types';

export default class HomePodFlow extends Shortcuts<AppleApp> {
    register(): void {
        this.#registerPlayUrl();
        this.#registerPlayUrlAtVolume();
        this.#registerSetPosition();
        this.#registerSkipBackward();
        this.#registerSkipForward();
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

    #registerSetPosition(): void {
        const card = this.flow.getActionCard('homepod_set_position');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly position: number;
        };

        card.registerRunListener(async ({device, position}: RunArguments) => {
            await device.airplay.remote.commandSeekToPosition(Math.floor(position));
        });
    }

    #registerSkipBackward(): void {
        const card = this.flow.getActionCard('homepod_skip_backward');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.airplay.remote.commandSkipBackward(Math.floor(seconds));
        });
    }

    #registerSkipForward(): void {
        const card = this.flow.getActionCard('homepod_skip_forward');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.airplay.remote.commandSkipForward(Math.floor(seconds));
        });
    }
}
