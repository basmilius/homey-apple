import { PassThrough } from 'node:stream';
import { Proto } from '@basmilius/apple-airplay';
import type { AirPlayDevice } from '@basmilius/apple-devices';
import type { Device } from '@basmilius/homey-common';
import Homey from 'homey';
import type { AppleApp } from '../types';

export default class AirPlayLogic {
    readonly #airplay: AirPlayDevice;
    readonly #device: Device<AppleApp>;

    #artwork!: Homey.Image;
    #artworkEmpty!: Homey.Image;
    #artworkURL?: string;
    #contentIdentifier?: string;

    constructor(device: Device<AppleApp>, airplay: AirPlayDevice) {
        this.#airplay = airplay;
        this.#device = device;

        this.#airplay.state.on('setState', async (message: Proto.SetStateMessage) => await this.#onSetState(message));
        this.#airplay.state.on('volumeDidChange', async () => await this.#onVolumeDidChange());
    }

    async finalize(): Promise<void> {
        await this.#device.setAlbumArtImage(this.#artwork);
    }

    async initialize(): Promise<void> {
        this.#artwork = await this.#device.homey.images.createImage();
        this.#artworkEmpty = await this.#device.homey.images.createImage();
    }

    async uninitialize(): Promise<void> {
        await this.#artwork.unregister();
        await this.#artworkEmpty.unregister();
    }

    async #clearNowPlaying(): Promise<void> {
        await this.#device.setCapabilityValue('speaker_album', '');
        await this.#device.setCapabilityValue('speaker_artist', '');
        await this.#device.setCapabilityValue('speaker_track', '');
        await this.#device.setCapabilityValue('speaker_duration', -1);
        await this.#device.setCapabilityValue('speaker_position', -1);
        await this.#device.setCapabilityValue('speaker_playing', false);

        this.log('Now playing info cleared.');
    }

    async #onSetState(message: Proto.SetStateMessage): Promise<void> {
        const client = this.#airplay.state.nowPlayingClient;

        if (message.playerPath?.client?.bundleIdentifier !== client?.bundleIdentifier) {
            return;
        }

        this.log('State update', message.playerPath?.client?.bundleIdentifier, client?.bundleIdentifier);
        this.log('Playback state update', client?.playbackState, client?.playbackStateTimestamp);

        if (!client) {
            await this.#clearNowPlaying();
            return;
        }

        const item = client.playbackQueue?.contentItems?.[0] ?? null;

        if (!item) {
            await this.#clearNowPlaying();
            return;
        }

        await this.#device.setCapabilityValue('speaker_playing', client.playbackState === Proto.PlaybackState_Enum.Playing);

        this.#contentIdentifier = item.identifier;

        await this.#device.setCapabilityValue('speaker_album', item.metadata.albumName);
        await this.#device.setCapabilityValue('speaker_artist', item.metadata.trackArtistName || client.displayName || '-');
        await this.#device.setCapabilityValue('speaker_track', item.metadata.title);
        await this.#device.setCapabilityValue('speaker_duration', item.metadata.duration);
        await this.#device.setCapabilityValue('speaker_position', item.metadata.elapsedTime);

        if (item.metadata.artworkAvailable) {
            if (item.metadata.artworkURL) {
                await this.#updateArtwork(item.metadata.artworkURL);
            } else if (item.artworkData?.byteLength > 0) {
                this.log('Artwork available in playback queue, updating...');
                await this.#updateArtworkBuffer(item.artworkData);
            } else if (this.#artworkURL !== this.#contentIdentifier) {
                this.log('Artwork not available, requesting...');
                this.#artworkURL = this.#contentIdentifier;
                await this.#airplay.requestPlaybackQueue(1);
            }
        } else {
            await this.#updateArtwork(null);
        }
    }

    async #onVolumeDidChange(): Promise<void> {
        if (!this.#device.hasCapability('volume_set')) {
            return;
        }

        this.log(`Volume changed to ${this.#airplay.state.volume}.`);
        await this.#device.setCapabilityValue('volume_set', this.#airplay.state.volume);
    }

    async #updateArtwork(url: string | null): Promise<void> {
        if (url) {
            await this.#device.setAlbumArtImage(this.#artwork);

            if (this.#artworkURL !== url) {
                this.#artworkURL = url;
                this.#artwork.setUrl(url);
                await this.#artwork.update();
            }
        } else {
            await this.#device.setAlbumArtImage(this.#artworkEmpty);
        }
    }

    async #updateArtworkBuffer(buffer: Buffer): Promise<void> {
        this.#artwork.setStream((stream: any) => {
            const pt = new PassThrough();
            pt.end(buffer);
            pt.pipe(stream);
        });
        await this.#artwork.update();
    }

    public log(...args: any[]): void {
        this.#device.log(...args);
    }
}
