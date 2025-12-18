import { HomePod, HomePodMini } from '@basmilius/apple-devices';
import { Device } from '@basmilius/homey-common';
import { AirPlayLogic } from '../logic';
import type { AppleApp } from '../types';
import { waitFor } from '../utils';
import type HomePodBaseDriver from './driver';

const CAPABILITIES = [
    'speaker_album',
    'speaker_artist',
    'speaker_duration',
    'speaker_next',
    'speaker_playing',
    'speaker_position',
    'speaker_prev',
    'speaker_stop',
    'speaker_track',
    'volume_set'
];

export default abstract class HomePodBaseDevice<TDriver extends HomePodBaseDriver> extends Device<AppleApp, TDriver> {
    #airplay!: AirPlayLogic;
    #homepod!: HomePod | HomePodMini;

    abstract createHomePodInstance(): Promise<HomePod | HomePodMini>;

    async onInit(): Promise<void> {
        this.#homepod = await this.createHomePodInstance();
        this.#homepod.on('connected', () => this.#onConnected());
        this.#homepod.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));

        this.#airplay = new AirPlayLogic(this, this.#homepod.airplay);
        await this.#airplay.initialize();

        await this.removeOldCapabilities(CAPABILITIES);
        await this.#registerCapabilities();
        await this.#connect();
        await this.#airplay.finalize();

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        await this.#airplay.uninitialize();
        await this.#homepod?.disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        try {
            await this.#homepod.connect();
        } catch (err) {
            this.error('Error received', err);
            await this.setUnavailable('Cannot connect to HomePod.');
        }
    }

    async #registerCapabilities(): Promise<void> {
        this.registerCapabilityListener('speaker_next', async () => {
            await this.#homepod.next();
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#homepod.previous();
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#homepod.stop();
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.#homepod.play();
            } else {
                await this.#homepod.pause();
            }
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.#homepod.airplay.sendButtonEvent(12, 0xE9, true);
            await this.#homepod.airplay.sendButtonEvent(12, 0xE9, false);
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.#homepod.airplay.sendButtonEvent(12, 0xEA, true);
            await this.#homepod.airplay.sendButtonEvent(12, 0xEA, false);
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.#homepod.airplay.sendButtonEvent(12, 0xE2, true);
            await this.#homepod.airplay.sendButtonEvent(12, 0xE2, false);
        });

        this.registerCapabilityListener('volume_set', async (volume: number) => {
            await this.#homepod.setVolume(volume);
        });
    }

    async #onConnected(): Promise<void> {
        await this.setAvailable();
    }

    async #onDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log(`Disconnected from HomePod "${this.getName()}", reconnecting in a moment...`);

        await this.setUnavailable('Disconnected from HomePod.');
        await waitFor(1000);

        await this.#connect();
    }
}
