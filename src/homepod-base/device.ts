import { UrlSource } from '@corewire/audio-source';
import { type DeviceTarget, HomePod, type Status } from '@corewire/devices';
import { DiscoverableDevice } from '../base';
import { AirPlayLogic } from '../logic';
import { capabilityToRepeatMode } from '../utils';
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

    get discoveryStrategy(): Homey.DiscoveryStrategy {
        return this.discovery.getStrategy('airplay');
    }

    get sdk(): HomePod {
        if (!this.#pod) {
            throw new Error('The HomePod is not connected yet. Try again in a moment.');
        }

        return this.#pod;
    }

    #airplayLogic!: AirPlayLogic;
    #availability: string | null = null;
    #hasConnected = false;
    #pod?: HomePod;
    #state: Status['state'] = 'disconnected';
    #teardown?: Promise<void>;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#airplayLogic = new AirPlayLogic(this);
        await this.#airplayLogic.initialize();

        await this.syncCapabilities(CAPABILITIES);
        this.#registerCapabilities();
        this.#registerMaintenance();

        await super.onInit();

        this.log('Initialized.');
    }

    async onDeleted(): Promise<void> {
        await this.#dispose();
    }

    async onUninit(): Promise<void> {
        await this.#dispose();

        this.log('Uninitialized.');
    }

    async onTargetFound(target: DeviceTarget): Promise<void> {
        if (this.#pod) {
            return;
        }

        this.#pod = new HomePod(target, {
            identity: this.app.clientIdentity,
            log: entry => this.writeLogEntry(entry),
            resolve: () => this.resolveTarget(),
            timing: this.app.useTimingServer ? undefined : false
        });

        this.#airplayLogic.setDevice(this.#pod);
        this.#pod.on('status', status => this.#onStatus(status));

        await this.#connect();
    }

    async playUrl(url: string, volume?: number): Promise<void> {
        if (!this.app.useTimingServer) {
            throw new Error('This Homey cannot play audio on a HomePod.');
        }

        if (!this.#pod) {
            throw new Error('The HomePod is not connected yet. Try again in a moment.');
        }

        try {
            if (volume !== undefined) {
                await this.sdk.volume.set(volume / 100);
            }

            // The stream volume replaces the speaker volume; without it the device falls back to -20 dB.
            const level = volume ?? (this.getCapabilityValue('volume_set') ?? 0.5) * 100;
            const audioSource = await UrlSource.fromUrl(url);
            const playback = await this.sdk.media.streamAudio(audioSource, {volume: level / 100});

            // The flow card resolves once the stream runs; waiting for the end would let Homey time it out.
            playback.ended.catch(err => this.error('Audio playback ended with an error:', err));
        } catch (err) {
            this.error('Failed to start audio playback:', err);
            throw err;
        }
    }

    async #connect(): Promise<void> {
        try {
            await this.sdk.connect();
        } catch (err) {
            // The device keeps retrying; the status handler reports it offline.
            this.error('Error received', err);
        }
    }

    async #dispose(): Promise<void> {
        this.#teardown ??= (async () => {
            await this.#airplayLogic?.uninitialize();
            await this.#pod?.disconnect();
        })();

        await this.#teardown;
    }

    async #onStatus(status: Status): Promise<void> {
        if (status.state !== this.#state) {
            this.log(`Status ${this.#state} -> ${status.state} (${status.reason})`, status.error?.message ?? '');
            this.#state = status.state;
        }

        try {
            await this.#updateAvailability(status);
        } catch (err) {
            this.error('Failed to update availability.', err);
        }
    }

    async #updateAvailability(status: Status): Promise<void> {
        let availability: string;

        switch (status.state) {
            case 'connected':
                availability = status.state;
                this.#hasConnected = true;
                break;

            case 'recovering':
                availability = this.#hasConnected
                    ? 'Lost the connection to the HomePod. Reconnecting...'
                    : 'Cannot connect to the HomePod. Trying again...';
                break;

            case 'offline':
                availability = 'The HomePod is not responding. Homey keeps trying to connect.';
                break;

            default:
                return;
        }

        if (availability === this.#availability) {
            return;
        }

        this.#availability = availability;

        if (status.state === 'connected') {
            await this.setAvailable();
        } else {
            await this.setUnavailable(availability);
        }
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
            await this.sdk.playback.setRepeat(capabilityToRepeatMode[value] ?? 'off');
        });

        this.registerCapabilityListener('speaker_shuffle', async (value: boolean) => {
            await this.sdk.playback.setShuffle(value ? 'songs' : 'off');
        });
    }

    #registerMaintenance(): void {
        this.registerCapabilityListener('button.restart', async () => {
            try {
                const pod = this.#pod;

                if (!pod) {
                    await this.findTarget();
                    return;
                }

                // The device announces everything fresh after a disconnect, which fills now playing again.
                await pod.disconnect();
                await this.#airplayLogic.clearNowPlaying();
                await this.#connect();
            } catch (err) {
                this.error(err);
            }
        });
    }
}
