import { Proto } from '@basmilius/apple-airplay';
import { HomePod, HomePodMini } from '@basmilius/apple-devices';
import { waitFor } from '@basmilius/utils';
import Homey from 'homey';

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

export default abstract class HomePodBaseDevice extends Homey.Device {
    #artwork!: Homey.Image;
    #artworkURL?: string;
    #homepod!: HomePod | HomePodMini;

    abstract createHomePodInstance(): Promise<HomePod | HomePodMini>;

    async onInit(): Promise<void> {
        this.#artwork = await this.homey.images.createImage();

        this.#homepod = await this.createHomePodInstance();
        this.#homepod.on('connected', () => this.#onConnected());
        this.#homepod.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));

        this.#homepod.airplay.state.on('setState', async (message: Proto.SetStateMessage) => await this.#onSetState(message));
        this.#homepod.airplay.state.on('volumeDidChange', async () => await this.#onVolumeDidChange());
        this.#homepod.airplay.state.on('setArtwork', async (message: any) => console.log(message));
        this.#homepod.airplay.state.on('updateContentItemArtwork', async (message: any) => console.log(message));

        await this.#updateCapabilities();
        await this.#registerCapabilities();
        await this.#connect();
        await this.setAlbumArtImage(this.#artwork);

        this.log(`HomePod "${this.getName()}" has been initialized.`);
    }

    async onUninit(): Promise<void> {
        await this.#artwork.unregister();
        await this.#homepod?.disconnect();

        this.log(`HomePod "${this.getName()}" has been uninitialized.`);
    }

    async #connect(): Promise<void> {
        this.log(`Connecting to HomePod "${this.getName()}"...`);

        try {
            await this.#homepod.connect();
        } catch (err) {
            this.error(`HomePod "${this.getName()}" received an error.`, err);
            await this.setUnavailable((err as Error).message);
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
    }

    async #onDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log(`Disconnected from HomePod "${this.getName()}", reconnecting in a moment...`);

        await waitFor(1000);
        await this.#connect();
    }

    async #onSetState(message: Proto.SetStateMessage): Promise<void> {
        const client = this.#homepod.airplay.state.nowPlayingClient;

        this.log(`Received state update from HomePod "${this.getName()}"`);
        this.log(message.playerPath?.client?.bundleIdentifier, client?.bundleIdentifier);
        this.log('PlaybackState', client?.playbackState);

        if (message.playerPath?.client?.bundleIdentifier !== client?.bundleIdentifier) {
            return;
        }

        if (!client) {
            await this.setCapabilityValue('speaker_album', '');
            await this.setCapabilityValue('speaker_artist', '');
            await this.setCapabilityValue('speaker_track', '');
            await this.setCapabilityValue('speaker_duration', -1);
            await this.setCapabilityValue('speaker_position', -1);
            await this.setCapabilityValue('speaker_playing', false);

            return;
        }

        await this.setCapabilityValue('speaker_playing', client.playbackState === Proto.PlaybackState_Enum.Playing);

        const item = client.playbackQueue?.contentItems?.[0] ?? null;

        if (!item) {
            // todo(Bas): Should we clear capability values here?
            return;
        }

        await this.setCapabilityValue('speaker_album', item.metadata.albumName);
        await this.setCapabilityValue('speaker_artist', item.metadata.trackArtistName || client.displayName || '-');
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
        this.log(`Volume of HomePod "${this.getName()}" changed to ${this.#homepod.airplay.state.volume}.`);
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
