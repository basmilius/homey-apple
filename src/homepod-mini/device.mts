import { Proto } from '@basmilius/apple-airplay';
// @ts-ignore
import { HomePodMini } from '@basmilius/apple-devices';
import Homey, { type DiscoveryResultMDNSSD } from 'homey';

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

export default class HomePodMiniDevice extends Homey.Device {
    #artwork!: Homey.Image;
    #artworkURL?: string;
    #homepod!: HomePodMini;

    async onInit(): Promise<void> {
        this.#artwork = await this.homey.images.createImage();

        try {
            await this.#updateCapabilities();
            await this.#connect();
            await this.#registerCapabilities();

            await this.setAlbumArtImage(this.#artwork);

            this.log(`HomePodMiniDevice ${this.getName()} has been initialized.`);
        } catch (err) {
            this.error(err);
            await this.setUnavailable((err as Error).message);
        }
    }

    async onUninit(): Promise<void> {
        await this.#homepod?.disconnect();

        this.log('HomePodMiniDevice has been uninitialized.');
    }

    async #connect(): Promise<void> {
        const device = await this.#discover();

        this.#homepod = new HomePodMini({
            address: device.address,
            service: {
                port: device.port
            },
            packet: {
                additionals: [{
                    rdata: device.txt
                }]
            }
        });

        try {
            await this.#homepod.connect();
        } catch (err) {
            this.error(err);
            await this.setUnavailable((err as Error).message);
            return;
        }

        this.#homepod.airplay.state.on('setState', async () => await this.#onSetState());
        this.#homepod.airplay.state.on('volumeDidChange', async () => await this.#onVolumeDidChange());
    }

    async #discover(): Promise<DiscoveryResultMDNSSD> {
        const strategy = this.homey.discovery.getStrategy('homepod-mini');
        const result = strategy.getDiscoveryResult(this.getStore().id);

        return result as DiscoveryResultMDNSSD;
    }

    async #registerCapabilities(): Promise<void> {
        this.registerCapabilityListener('speaker_next', async () => {
            await this.#homepod.next();
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#homepod.previous();
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#homepod.stop()
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

    async #onSetState(): Promise<void> {
        await this.setCapabilityValue('speaker_playing', this.#homepod.playbackState === Proto.PlaybackState_Enum.Playing);

        const item = this.#homepod.playbackQueue?.contentItems?.[0] ?? null;

        if (!item) {
            // todo(Bas): Figure out if we want to clear capabilities here.
            return;
        }

        await this.setCapabilityValue('speaker_album', item.metadata.albumName);
        await this.setCapabilityValue('speaker_artist', item.metadata.trackArtistName);
        await this.setCapabilityValue('speaker_track', item.metadata.title);
        await this.setCapabilityValue('speaker_duration', item.metadata.duration);
        await this.setCapabilityValue('speaker_position', item.metadata.elapsedTime);

        if (item.metadata.artworkAvailable && item.metadata.artworkURL) {
            await this.#updateArtwork(item.metadata.artworkURL);
        } else {
            await this.#updateArtwork(null);
        }
    }

    async #onVolumeDidChange(): Promise<void> {
        this.log(`Volume changed to ${this.#homepod.airplay.state.volume}`);
        await this.setCapabilityValue('volume_set', this.#homepod.airplay.state.volume);
    }

    async #updateArtwork(url: string | null): Promise<void> {
        if (url) {
            if (this.#artworkURL !== url) {
                this.#artwork.setUrl(url);
                this.#artworkURL = url;
                await this.#artwork.update();
            }
        } else {
            // todo(Bas): clear artwork.
        }
    }

    async #updateCapabilities(): Promise<void> {
        const currentCapabilities = this.getCapabilities();

        for (const capability of CAPABILITIES) {
            if (currentCapabilities.includes(capability)) {
                continue;
            }

            await this.addCapability(capability);
        }

        for (const capability of currentCapabilities) {
            if (CAPABILITIES.includes(capability)) {
                continue;
            }

            await this.removeCapability(capability);
        }
    }
}
