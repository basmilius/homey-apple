import { Shortcuts } from '@basmilius/homey-common';
import type Homey from 'homey';
import type { AppleApp, HomePodBaseDevice, HomePodBaseDriver } from '../types';
import type { SoundBoardSound } from '../utils';

export default class HomePodFlow extends Shortcuts<AppleApp> {
    register(): void {
        this.#registerPlaySoundboard();
        this.#registerPlayUrl();
        this.#registerPlayUrlAtVolume();
        this.#registerSetPosition();
        this.#registerSkipBackward();
        this.#registerSkipForward();
    }

    async triggerArtworkUrlUpdated(device: HomePodBaseDevice<HomePodBaseDriver>, localUrl: string, cloudUrl: string): Promise<void> {
        try {
            const triggerCard = this.flow.getDeviceTriggerCard('homepod_artwork_url_updated');

            await triggerCard.trigger(device, {
                localUrl,
                cloudUrl
            });
        } catch (err) {
            this.log(device.name, 'Failed to trigger artwork url updated card.', err);
        }
    }

    #registerPlaySoundboard(): void {
        const card = this.homey.flow.getActionCard('homepod_play_soundboard');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly sound: SoundBoardSound;
            readonly volume: number;
        };

        card.registerRunListener(async ({device, sound, volume}: RunArguments) => {
            await device.playSoundboard(sound, volume);
        });

        card.registerArgumentAutocompleteListener('sound', async (query: string): Promise<Homey.FlowCard.ArgumentAutocompleteResults> => {
            const sounds = await this.app.soundBoard.getSounds();
            const lowerQuery = query.trim().toLowerCase();

            return sounds
                .filter(sound => lowerQuery.length === 0 || sound.name.toLowerCase().includes(lowerQuery))
                .sort((a, b) => a.name.localeCompare(b.name));
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
            await device.sdk.playback.seekTo(Math.floor(position));
        });
    }

    #registerSkipBackward(): void {
        const card = this.flow.getActionCard('homepod_skip_backward');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.sdk.playback.skipBackward(Math.floor(seconds));
        });
    }

    #registerSkipForward(): void {
        const card = this.flow.getActionCard('homepod_skip_forward');

        type RunArguments = {
            readonly device: HomePodBaseDevice<HomePodBaseDriver>;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.sdk.playback.skipForward(Math.floor(seconds));
        });
    }
}
