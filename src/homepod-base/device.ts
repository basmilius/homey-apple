import { Proto } from '@basmilius/apple-airplay';
import { Url as UrlAudioSource } from '@basmilius/apple-audio-source';
import { AIRPLAY_SERVICE, type DiscoveryResult } from '@basmilius/apple-common';
import { RaopClient } from '@basmilius/apple-raop';
import { DiscoverableDevice } from '../base';
import { AirPlayConnection } from '../connection';
import { AirPlayLogic } from '../logic';
import { getAccessoryCredentialsFromDevice, waitFor } from '../utils';
import type HomePodBaseDriver from './driver';
import type Homey from 'homey';

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
    'artwork_url',
    'artwork_url_cloud',
    'artwork_url_local',
    'volume_down',
    'volume_set',
    'volume_up',
    'button.restart'
];

export default abstract class HomePodBaseDevice<TDriver extends HomePodBaseDriver> extends DiscoverableDevice<TDriver> {
    get airplay(): AirPlayConnection {
        return this.#airplay;
    }

    get airplayLogic(): AirPlayLogic {
        return this.#airplayLogic;
    }

    get discoveryResult(): DiscoveryResult {
        return this.discoveryResults[AIRPLAY_SERVICE];
    }

    get services(): Record<string, Homey.DiscoveryStrategy> {
        return this.#services;
    }

    #airplay!: AirPlayConnection;
    #airplayLogic!: AirPlayLogic;
    #connectedOnce = false;
    #services!: Record<string, Homey.DiscoveryStrategy>;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#services = {
            [AIRPLAY_SERVICE]: this.discovery.getStrategy('airplay')
        };

        this.#airplayLogic = new AirPlayLogic(this);
        await this.#airplayLogic.initialize();

        this.#airplay = new AirPlayConnection(this);
        this.#airplay.on('connected', () => this.#onConnected());
        this.#airplay.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));

        await this.syncCapabilities(CAPABILITIES);
        this.#registerCapabilities();
        this.#registerMaintenance();

        await super.onInit();

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        await this.#airplayLogic.uninitialize();
        await this.#disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        try {
            const credentials = getAccessoryCredentialsFromDevice(this);

            this.#airplay.createInstance(credentials, this.discoveryResult);
            await this.#airplay.connect();
        } catch (err) {
            this.error('Error received', err);
            await this.setUnavailable('Cannot connect to HomePod.');
        }
    }

    async #disconnect(): Promise<void> {
        await this.#airplay.disconnect();
    }

    async #onConnected(): Promise<void> {
        await this.setAvailable();
    }

    async #onDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log('Disconnected from HomePod, reconnecting...');
        await this.setUnavailable('Disconnected from HomePod, reconnecting...');
        await waitFor(1000);

        await this.findService(AIRPLAY_SERVICE);
        await this.#airplay.reconnect(this.discoveryResult);
    }

    #registerCapabilities(): void {
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

    #registerMaintenance(): void {
        this.registerCapabilityListener('button.restart', async () => {
            await this.#disconnect();
            await this.#airplayLogic.clearNowPlaying();
            await this.#connect();
        });
    }

    async onServiceFound(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        await super.onServiceFound(service, discoveryResult);

        if (this.#connectedOnce) {
            return;
        }

        if (!this.discoveryResult) {
            return;
        }

        this.#connectedOnce = true;
        await this.#connect();
    }

    async playUrl(url: string, volume?: number): Promise<void> {
        if (!this.app.useTimingServer) {
            throw new Error('Timing server is not enabled.');
        }

        const client = await RaopClient.create(this.discoveryResult, this.app.timingServer);
        const audioSource = await UrlAudioSource.fromUrl(url);

        // Let the actual playback happen in the background.
        new Promise<void>(async resolve => {
            await client.stream(audioSource, {
                metadata: {
                    title: 'Olympics',
                    artist: 'RAOP Test',
                    album: 'Test Album',
                    duration: 5
                },
                volume
            });

            await client.close();

            resolve();
        });
    }
}
