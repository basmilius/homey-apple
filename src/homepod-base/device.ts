import { Proto } from '@basmilius/apple-airplay';
import { Device } from '@basmilius/homey-common';
import { AirPlayConnection } from '../connection';
import type { AppleApp } from '../types';
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
    #airplay!: AirPlayConnection;

    abstract createAirPlayConnection(): Promise<AirPlayConnection>;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#airplay = await this.createAirPlayConnection();
        this.#airplay.on('connected', () => this.#onConnected());

        await this.removeOldCapabilities(CAPABILITIES);
        await this.#registerCapabilities();
        await this.#connect();

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        await this.#airplay?.disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        try {
            await this.#airplay.createInstance();
            await this.#airplay.connect();
        } catch (err) {
            this.error('Error received', err);
            await this.setUnavailable('Cannot connect to HomePod.');
        }
    }

    async #registerCapabilities(): Promise<void> {
        this.registerCapabilityListener('speaker_next', async () => {
            await this.#airplay.sendCommand(Proto.Command.NextInContext);
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#airplay.sendCommand(Proto.Command.PreviousInContext);
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#airplay.sendCommand(Proto.Command.Stop);
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.#airplay.sendCommand(Proto.Command.Play);
            } else {
                await this.#airplay.sendCommand(Proto.Command.Pause);
            }
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.#airplay.remote.volumeUp();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.#airplay.remote.volumeDown();
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.#airplay.remote.mute();
        });

        this.registerCapabilityListener('volume_set', async (volume: number) => {
            await this.#airplay.setVolume(volume);
        });
    }

    async #onConnected(): Promise<void> {
        await this.setAvailable();
    }
}
