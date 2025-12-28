import { PassThrough } from 'node:stream';
import { Proto } from '@basmilius/apple-airplay';
import type { AirPlayDevice } from '@basmilius/apple-devices';
import { type Device, Shortcuts } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import Homey from 'homey';

export default class AirPlayLogic extends Shortcuts<AppleApp> {
    get deviceName(): string {
        return this.#device.name;
    }

    readonly #device: Device<AppleApp, any>;

    #artwork!: Homey.Image;
    #artworkEmpty!: Homey.Image;
    #artworkIdentifier?: string;
    #protocol: AirPlayDevice;

    constructor(device: Device<AppleApp, any>) {
        super(device.app);

        this.#device = device;
    }

    async initialize(): Promise<void> {
        this.#artwork = await this.#device.homey.images.createImage();
        this.#artworkEmpty = await this.#device.homey.images.createImage();
        await this.#device.setAlbumArtImage(this.#artworkEmpty);
        await this.#clearNowPlaying();
    }

    async setProtocol(protocol: AirPlayDevice): Promise<void> {
        this.#protocol = protocol;

        this.#protocol.state.on('setNowPlayingClient', async (message: Proto.SetNowPlayingClientMessage) => await this.#onSetNowPlayingClient(message));
        this.#protocol.state.on('setState', async (message: Proto.SetStateMessage) => await this.#onSetState(message));
        this.#protocol.state.on('updateContentItem', async (message: Proto.UpdateContentItemMessage) => await this.#onUpdateContentItem(message));
        this.#protocol.state.on('volumeDidChange', async () => await this.#onVolumeDidChange());
    }

    async uninitialize(): Promise<void> {
        await this.#artwork.unregister();
        await this.#artworkEmpty.unregister();
    }

    async #clearNowPlaying(): Promise<void> {
        await this.#updateArtwork(null);

        await this.#device.setCapabilityValue('speaker_album', '');
        await this.#device.setCapabilityValue('speaker_artist', '');
        await this.#device.setCapabilityValue('speaker_track', '');
        await this.#device.setCapabilityValue('speaker_duration', -1);
        await this.#device.setCapabilityValue('speaker_position', -1);
        await this.#device.setCapabilityValue('speaker_playing', false);

        this.log(this.deviceName, 'Now playing info cleared.');
    }

    async #onSetNowPlayingClient(message: Proto.SetNowPlayingClientMessage): Promise<void> {
        this.log(this.deviceName, `Now playing client updated to ${message.client?.bundleIdentifier}.`);
    }

    async #onSetState(message: Proto.SetStateMessage): Promise<void> {
        const client = this.#protocol.state.nowPlayingClient;

        if (message.playerPath?.client?.bundleIdentifier !== client?.bundleIdentifier) {
            return;
        }

        this.log(this.deviceName, 'State update', message.playerPath?.client?.bundleIdentifier, message.playbackState, message.playbackStateTimestamp);

        await this.#updateNowPlaying();
    }

    async #onUpdateContentItem(message: Proto.UpdateContentItemMessage): Promise<void> {
        this.log(this.deviceName, 'Content item update', message.playerPath?.client?.bundleIdentifier, message.contentItems.length);

        await this.#updateNowPlaying();
    }

    async #onVolumeDidChange(): Promise<void> {
        if (!this.#device.hasCapability('volume_set')) {
            return;
        }

        this.log(this.deviceName, `Volume changed to ${this.#protocol.state.volume}.`);
        await this.#device.setCapabilityValue('volume_set', this.#protocol.state.volume);
    }

    async #setArtwork(identifier: string, item: Proto.ContentItem): Promise<void> {
        if (identifier === this.#artworkIdentifier) {
            return;
        }

        this.log(this.deviceName, 'Artwork identifier changed.', identifier, this.#artworkIdentifier);

        if (!item.metadata.artworkAvailable) {
            this.log(this.deviceName, 'Artwork not available.');
            await this.#updateArtwork(null);
            return;
        }

        this.#artworkIdentifier = identifier;

        if (item.metadata.artworkURL) {
            this.log(this.deviceName, 'Artwork available as URL.');
            await this.#updateArtwork(item.metadata.artworkURL);
            return;
        }

        if (item.artworkData?.byteLength > 0) {
            this.log(this.deviceName, 'Artwork data available in playback queue.');
            await this.#updateArtworkBuffer(item.artworkData);
            return;
        }

        this.log(this.deviceName, 'Artwork available, but not yet, requesting...');
        await this.#updateArtwork(null);
        await this.#protocol?.requestPlaybackQueue(1);
    }

    async #updateArtwork(url: string | null): Promise<void> {
        if (url) {
            await this.#device.setAlbumArtImage(this.#artwork);

            if (this.#artworkIdentifier !== url) {
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

    async #updateNowPlaying(): Promise<void> {
        const client = this.#protocol.state.nowPlayingClient;
        const item = client?.playbackQueue?.contentItems?.[0] ?? null;

        this.log(this.deviceName, 'Now playing info updated.', client?.bundleIdentifier, item?.metadata?.title);

        if (!item) {
            return;
        }

        await this.#device.setCapabilityValue('speaker_playing', client.playbackState === Proto.PlaybackState_Enum.Playing);
        await this.#device.setCapabilityValue('speaker_album', item.metadata.albumName);
        await this.#device.setCapabilityValue('speaker_artist', item.metadata.trackArtistName || client.displayName || '-');
        await this.#device.setCapabilityValue('speaker_track', item.metadata.title);
        await this.#device.setCapabilityValue('speaker_duration', item.metadata.duration);
        await this.#device.setCapabilityValue('speaker_position', item.metadata.elapsedTime);

        if (this.#device.hasCapability('now_playing_app')) {
            await this.#device.setCapabilityValue('now_playing_app', client.playbackState === Proto.PlaybackState_Enum.Playing ? client.displayName : null);
        }

        await this.#setArtwork(item.metadata.artworkIdentifier, item);
    }
}
