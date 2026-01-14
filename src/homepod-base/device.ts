import { Proto } from '@basmilius/apple-airplay';
import { Device } from '@basmilius/homey-common';
import { AirPlayConnection } from '../connection';
import { AirPlayLogic } from '../logic';
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
    'volume_down',
    'volume_set',
    'volume_up',
    'button.restart'
];

export default abstract class HomePodBaseDevice<TDriver extends HomePodBaseDriver> extends Device<AppleApp, TDriver> {
    get airplay(): AirPlayConnection {
        return this.#airplay;
    }

    get airplayLogic(): AirPlayLogic {
        return this.#airplayLogic;
    }

    #airplay!: AirPlayConnection;
    #airplayLogic!: AirPlayLogic;

    abstract createAirPlayConnection(): Promise<AirPlayConnection>;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#airplayLogic = new AirPlayLogic(this);
        await this.#airplayLogic.initialize();

        this.#airplay = await this.createAirPlayConnection();
        this.#airplay.on('connected', () => this.#onConnected());

        await this.removeOldCapabilities(CAPABILITIES);
        await this.#registerCapabilities();
        await this.#registerMaintenance();
        await this.#connect();

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        await this.#airplayLogic.uninitialize();
        await this.#disconnect();

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

    async #disconnect(): Promise<void> {
        await this.#airplay.disconnect();
    }

    async #registerCapabilities(): Promise<void> {
        this.registerCapabilityListener('speaker_next', async () => {
            await this.#airplay.protocol.sendCommand(Proto.Command.NextInContext);
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#airplay.protocol.sendCommand(Proto.Command.PreviousInContext);
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#airplay.protocol.sendCommand(Proto.Command.Stop);
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.#airplay.protocol.sendCommand(Proto.Command.Play);
            } else {
                await this.#airplay.protocol.sendCommand(Proto.Command.Pause);
            }
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.#airplay.protocol.volume.up();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.#airplay.protocol.volume.down();
        });

        this.registerCapabilityListener('volume_set', async (volume: number) => {
            await this.#airplay.protocol.volume.set(volume);
        });
    }

    async #registerMaintenance(): Promise<void> {
        this.registerCapabilityListener('button.restart', async () => {
            await this.#disconnect();
            await this.#airplayLogic.clearNowPlaying();
            await this.#connect();
        });
    }

    async #onConnected(): Promise<void> {
        await this.setAvailable();
    }

    async setAvailable(): Promise<void> {
        try {
            await super.setAvailable();
        } catch (err) {
            this.app.log('Error while setting device available', err);
        }
    }

    async setUnavailable(message?: string | null | undefined): Promise<void> {
        try {
            await super.setUnavailable(message);
        } catch (err) {
            this.app.log('Error while setting device unavailable', err);
        }
    }
}
