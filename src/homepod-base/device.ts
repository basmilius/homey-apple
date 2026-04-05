import { Url } from '@basmilius/apple-audio-source';
import { AIRPLAY_SERVICE, ConnectionRecovery, type DiscoveryResult, HomePod, Proto } from '@basmilius/apple-sdk';
import { DiscoverableDevice } from '../base';
import { AirPlayLogic } from '../logic';
import { capabilityToRepeatMode, type SoundBoardSound } from '../utils';
import type HomePodBaseDriver from './driver';
import type Homey from 'homey';

const RECONNECT_INTERVAL = 15 * 60 * 1000;

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
    'speaker_repeat',
    'speaker_shuffle',
    'artwork_url',
    'artwork_url_cloud',
    'artwork_url_local',
    'volume_down',
    'volume_set',
    'volume_up',
    'button.restart'
];

export default abstract class HomePodBaseDevice<TDriver extends HomePodBaseDriver> extends DiscoverableDevice<TDriver> {
    get airplayLogic(): AirPlayLogic {
        return this.#airplayLogic;
    }

    get discoveryResult(): DiscoveryResult {
        return this.discoveryResults[AIRPLAY_SERVICE];
    }

    get sdk(): HomePod {
        if (!this.#pod) {
            throw new Error('HomePod SDK device is not initialized.');
        }

        return this.#pod;
    }

    get services(): Record<string, Homey.DiscoveryStrategy> {
        return this.#services;
    }

    #airplayLogic!: AirPlayLogic;
    #connectedOnce = false;
    #pod?: HomePod;
    #recovery?: ConnectionRecovery;
    #services!: Record<string, Homey.DiscoveryStrategy>;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#services = {
            [AIRPLAY_SERVICE]: this.discovery.getStrategy('airplay')
        };

        this.#airplayLogic = new AirPlayLogic(this);
        await this.#airplayLogic.initialize();

        await this.syncCapabilities(CAPABILITIES);
        this.#registerCapabilities();
        this.#registerMaintenance();

        await super.onInit();

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        this.#recovery?.dispose();
        await this.#airplayLogic.uninitialize();
        this.#pod?.disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        try {
            if (!this.discoveryResult) {
                await this.setUnavailable('Service discovery not complete, waiting for device...');
                return;
            }

            // Create or reconfigure the SDK device.
            if (!this.#pod) {
                this.#pod = new HomePod({
                    airplay: this.discoveryResult
                });

                this.#airplayLogic.setDevice(this.#pod);
                this.#wireEvents();
                this.#setupRecovery();
            } else {
                this.#pod.discoveryResult = this.discoveryResult;
            }

            await this.#pod.connect();
        } catch (err) {
            this.error('Error received', err);
            await this.setUnavailable('Cannot connect to HomePod.');
        }
    }

    #wireEvents(): void {
        if (!this.#pod) {
            return;
        }

        this.#pod.on('connected', async () => {
            this.#recovery?.reset();
            await this.setAvailable();
        });

        this.#pod.on('disconnected', async (unexpected: boolean) => {
            if (!unexpected) {
                return;
            }

            this.log('Disconnected from HomePod, reconnecting...');
            await this.setUnavailable('Disconnected from HomePod, reconnecting...');
            this.#recovery?.handleDisconnect(unexpected);
        });
    }

    #setupRecovery(): void {
        this.#recovery?.dispose();

        this.#recovery = new ConnectionRecovery({
            maxAttempts: 3,
            baseDelay: 1000,
            reconnectInterval: RECONNECT_INTERVAL,
            onReconnect: async () => {
                const pod = this.#pod;
                if (!pod) return;
                pod.airplay.disconnectSafely();
                await this.findService(AIRPLAY_SERVICE);
                pod.discoveryResult = this.discoveryResults[AIRPLAY_SERVICE];
                await pod.airplay.connect();
            }
        });

        this.#recovery.on('recovering', (attempt) => {
            this.log(`AirPlay recovery attempt ${attempt}...`);
        });

        this.#recovery.on('failed', () => {
            this.error('AirPlay recovery failed after max attempts.');
        });
    }

    #registerCapabilities(): void {
        this.registerCapabilityListener('speaker_next', async () => {
            await this.sdk.playback.next();
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.sdk.playback.previous();
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.sdk.playback.stop();
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.sdk.playback.play();
            } else {
                await this.sdk.playback.pause();
            }
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.sdk.volume.up();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.sdk.volume.down();
        });

        this.registerCapabilityListener('volume_set', async (volume: number) => {
            await this.sdk.volume.set(volume);
        });

        this.registerCapabilityListener('speaker_repeat', async (value: string) => {
            await this.sdk.playback.setRepeatMode(capabilityToRepeatMode[value] ?? Proto.RepeatMode_Enum.Off);
        });

        this.registerCapabilityListener('speaker_shuffle', async (value: boolean) => {
            const mode = value ? Proto.ShuffleMode_Enum.Songs : Proto.ShuffleMode_Enum.Off;
            await this.sdk.playback.setShuffleMode(mode);
        });
    }

    #registerMaintenance(): void {
        this.registerCapabilityListener('button.restart', async () => {
            try {
                this.#pod?.disconnect();
                this.#pod = undefined;
                await this.#airplayLogic.clearNowPlaying();
                await this.#connect();
            } catch (err) {
                this.error(err);
            }
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

    async playSoundboard(sound: SoundBoardSound, volume?: number): Promise<void> {
        const url = await this.app.soundBoard.getSoundUrl(sound);
        await this.playUrl(url, volume);
    }

    async playUrl(url: string, volume?: number): Promise<void> {
        if (!this.app.useTimingServer) {
            throw new Error('Timing server is not enabled.');
        }

        if (!this.#pod) {
            throw new Error('HomePod is not connected.');
        }

        try {
            if (volume !== undefined) {
                await this.sdk.volume.set(volume);
            }

            const audioSource = await Url.fromUrl(url);
            await this.sdk.media.streamAudio(audioSource);
        } catch (err) {
            this.error('Failed to start audio playback:', err);
            throw err;
        }
    }
}
