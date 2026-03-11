import { Proto } from '@basmilius/apple-airplay';
import { Shortcuts } from '@basmilius/homey-common';
import type { AppleApp, HomePodBaseDevice, HomePodBaseDriver } from '../types';

export default class HomePodFlow extends Shortcuts<AppleApp> {
    register(): void {
        this.#registerPlayUrl();
        this.#registerPlayUrlAtVolume();
        this.#registerSeekToPosition();
        this.#registerSkipForward();
        this.#registerSkipBackward();
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

    #registerSeekToPosition(): void {
        const card = this.homey.flow.getActionCard('homepod_set_position');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly position: number;
        };

        card.registerRunListener(async ({device, position}: RunArguments) => {
            await device.airplay.protocol.sendCommand(Proto.Command.SeekToPlaybackPosition, {playbackPosition: position} as unknown as Proto.CommandOptions);
        });
    }

    #registerSkipForward(): void {
        const card = this.homey.flow.getActionCard('homepod_skip_forward');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.airplay.protocol.sendCommand(Proto.Command.SkipForward, {skipInterval: seconds} as unknown as Proto.CommandOptions);
        });
    }

    #registerSkipBackward(): void {
        const card = this.homey.flow.getActionCard('homepod_skip_backward');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.airplay.protocol.sendCommand(Proto.Command.SkipBackward, {skipInterval: seconds} as unknown as Proto.CommandOptions);
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
