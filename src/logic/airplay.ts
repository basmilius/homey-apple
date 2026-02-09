import { PassThrough } from 'node:stream';
import { Proto } from '@basmilius/apple-airplay';
import type { AirPlayDevice } from '@basmilius/apple-devices';
import { debounce, type Device, Shortcuts } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import Homey from 'homey';
import AppleTVDevice from '../apple-tv/device';

export default class AirPlayLogic extends Shortcuts<AppleApp> {
    get deviceName(): string {
        return this.#device.name;
    }

    readonly #device: Device<AppleApp, any>;

    #artwork!: Homey.Image;
    #artworkIdentifier?: string;
    #artworkRequestingIdentifier?: string;
    #protocol: AirPlayDevice;

    readonly #updateNowPlayingApp: (bundleIdentifier: string | null, displayName: string | null) => Promise<void>;

    constructor(device: Device<AppleApp, any>) {
        super(device.app);

        this.#device = device;

        this.#updateNowPlayingApp = debounce(this.#updateNowPlayingAppImpl, 1000, this);
    }

    async initialize(): Promise<void> {
        this.#artwork = await this.#device.homey.images.createImage();
        await this.#device.setAlbumArtImage(this.#artwork);
        
        // Set the artwork URL capability once - the URL never changes, only the image content
        if (this.#device.hasCapability('artwork_url')) {
            // @ts-expect-error: The file property exists on Homey.Image but may not be in the type definition
            const artworkFile = this.#artwork.file;
            if (artworkFile) {
                const artworkUrl = `url(\${window.location.origin}/app/com.basmilius.apple${artworkFile})`;
                await this.#device.setCapabilityValue('artwork_url', artworkUrl);
                this.log(this.deviceName, 'Artwork URL set:', artworkUrl);
            }
        }
        
        await this.clearNowPlaying();
    }

    async uninitialize(): Promise<void> {
        this.#protocol.state.removeAllListeners();
        await this.#artwork.unregister();
    }

    async clearNowPlaying(): Promise<void> {
        try {
            this.#artworkIdentifier = undefined;
            await this.#updateArtwork(null);
            await this.#updateNowPlayingApp(null, null);

            await this.#device.setCapabilityValue('speaker_album', '');
            await this.#device.setCapabilityValue('speaker_artist', '');
            await this.#device.setCapabilityValue('speaker_track', '');
            await this.#device.setCapabilityValue('speaker_duration', -1);
            await this.#device.setCapabilityValue('speaker_position', -1);
            await this.#device.setCapabilityValue('speaker_playing', false);

            this.log(this.deviceName, 'Now playing info cleared.');
        } catch (err) {
            this.log(this.deviceName, 'Failed to clear now playing info', err);
        }
    }

    setProtocol(protocol: AirPlayDevice): void {
        this.#protocol = protocol;

        // this.#protocol.state.on('setArtwork', (message: Proto.SetArtworkMessage) => this.log('setArtwork', message));
        // this.#protocol.state.on('updateContentItemArtwork', (message: Proto.UpdateContentItemArtworkMessage) => this.log('updateContentItemArtwork', message.contentItems[0]));

        this.#protocol.state.on('setNowPlayingClient', this.#onSetNowPlayingClient.bind(this));
        this.#protocol.state.on('setState', this.#onSetState.bind(this));
        this.#protocol.state.on('updateContentItem', this.#onUpdateContentItem.bind(this));
        this.#protocol.state.on('volumeDidChange', async () => await this.#onVolumeDidChange());
    }

    async #onSetNowPlayingClient(message: Proto.SetNowPlayingClientMessage): Promise<void> {
        this.log(this.deviceName, `Now playing client updated to ${message.client?.bundleIdentifier}.`);

        if (!message.client?.bundleIdentifier) {
            await this.clearNowPlaying();
        }
    }

    async #onSetState(message: Proto.SetStateMessage): Promise<void> {
        const client = this.#protocol.state.nowPlayingClient;

        this.log(this.deviceName, 'State received', message.playbackState, message.playbackStateTimestamp, message.playerPath?.client?.bundleIdentifier);

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
        try {
            if (!this.#device.hasCapability('volume_set')) {
                return;
            }

            this.log(this.deviceName, `Volume changed to ${this.#protocol.state.volume}.`);
            await this.#device.setCapabilityValue('volume_set', this.#protocol.state.volume);
        } catch (err) {
            this.log(this.deviceName, 'Failed to update volume:', err);
        }
    }

    async #setArtwork(identifier: string, item: Proto.ContentItem): Promise<void> {
        if (identifier === this.#artworkIdentifier) {
            this.log(this.deviceName, 'Artwork identifier unchanged.', identifier);
            return;
        }

        this.log(this.deviceName, 'Artwork identifier changed.', identifier);

        if (!item.metadata.artworkAvailable) {
            this.log(this.deviceName, 'Artwork not available.');
            await this.#updateArtwork(null);
            return;
        }

        if (item.metadata.artworkURL) {
            this.log(this.deviceName, 'Artwork available as URL.');
            this.#artworkIdentifier = identifier;
            await this.#updateArtwork(item.metadata.artworkURL);
            return;
        }

        if (item.artworkData?.byteLength > 0) {
            this.log(this.deviceName, 'Artwork data available in playback queue.');
            this.#artworkIdentifier = identifier;
            await this.#updateArtworkBuffer(item.artworkData);
            return;
        }

        if (this.#artworkRequestingIdentifier === identifier) {
            this.log(this.deviceName, 'Artwork available, but already requested.');
            return;
        }

        try {
            this.log(this.deviceName, 'Artwork available, but not yet, requesting...');
            this.#artworkRequestingIdentifier = identifier;
            await this.#updateArtwork(null);
            await this.#protocol.requestPlaybackQueue(1);
        } catch (err) {
            this.#device.error(this.deviceName, 'Failed to request artwork from playback queue', err);
        }
    }

    async #updateArtwork(url: string | null): Promise<void> {
        try {
            if (url) {
                this.#artwork.setUrl(url.replace('.heic', '.jpg'));
            } else {
                // @ts-ignore: The type definition of Homey.Image.setUrl() is incorrect.
                this.#artwork.setUrl(null);
            }

            await this.#artwork.update();
            await this.#updateArtworkUrlWithCacheBuster();
        } catch (err) {
            this.log(this.deviceName, 'Failed to update album artwork', err);
        }
    }

    async #updateArtworkBuffer(buffer: Buffer): Promise<void> {
        await this.#device.setAlbumArtImage(this.#artwork);
        this.#artwork.setStream((stream: any) => {
            const pt = new PassThrough();
            pt.end(buffer);
            pt.pipe(stream);
        });
        await this.#artwork.update();
        await this.#updateArtworkUrlWithCacheBuster();
    }

    async #updateArtworkUrlWithCacheBuster(): Promise<void> {
        try {
            if (!this.#device.hasCapability('artwork_url')) {
                return;
            }

            // @ts-expect-error: The file property exists on Homey.Image but may not be in the type definition
            const artworkFile = this.#artwork.file;
            
            if (artworkFile) {
                // Add cache buster to force reload of the image
                const cacheBuster = Date.now();
                const artworkUrl = `url(\${window.location.origin}/app/com.basmilius.apple${artworkFile}?v=${cacheBuster})`;
                await this.#device.setCapabilityValue('artwork_url', artworkUrl);
                this.log(this.deviceName, 'Artwork URL updated with cache buster:', cacheBuster);
            }
        } catch (err) {
            this.log(this.deviceName, 'Failed to update artwork URL', err);
        }
    }

    async #updateNowPlaying(): Promise<void> {
        const client = this.#protocol.state.nowPlayingClient;
        const device = this.#device;
        const item = client?.playbackQueue?.contentItems?.[0] ?? null;

        this.log(this.deviceName, 'Now playing info updated.', client?.bundleIdentifier, item?.metadata?.title);

        if (!item) {
            return;
        }

        try {
            if (client) {
                const hasSpeakerNext = device.hasCapability('speaker_next');
                const hasSpeakerPrev = device.hasCapability('speaker_prev');
                const isNextSupported = client.isCommandSupported(Proto.Command.NextTrack);
                const isPrevSupported = client.isCommandSupported(Proto.Command.PreviousTrack);

                if (isNextSupported && !hasSpeakerNext) {
                    await device.addCapability('speaker_next');
                } else if (!isNextSupported && hasSpeakerNext) {
                    await device.removeCapability('speaker_next');
                }

                if (isPrevSupported && !hasSpeakerPrev) {
                    await device.addCapability('speaker_prev');
                } else if (!isPrevSupported && hasSpeakerPrev) {
                    await device.removeCapability('speaker_prev');
                }
            }

            await device.setCapabilityValue('speaker_playing', client?.playbackState === Proto.PlaybackState_Enum.Playing);
            await device.setCapabilityValue('speaker_album', item.metadata.albumName);
            await device.setCapabilityValue('speaker_artist', item.metadata.trackArtistName || client?.displayName || '-');
            await device.setCapabilityValue('speaker_track', item.metadata.title);
            await device.setCapabilityValue('speaker_duration', item.metadata.duration);
            await device.setCapabilityValue('speaker_position', item.metadata.elapsedTime);

            const nowPlayingAppBundleIdentifier = client?.playbackState === Proto.PlaybackState_Enum.Playing
                ? client.bundleIdentifier
                : null;

            const nowPlayingAppDisplayName = client?.playbackState === Proto.PlaybackState_Enum.Playing
                ? client.displayName
                : null;

            await this.#updateNowPlayingApp(nowPlayingAppBundleIdentifier, nowPlayingAppDisplayName);
            await this.#setArtwork(item.metadata.artworkIdentifier || item.metadata.contentIdentifier || item.identifier, item);
        } catch (err) {
            this.log(this.deviceName, 'Failed to update now playing info', err);
        }
    }

    async #updateNowPlayingAppImpl(bundleIdentifier: string | null, displayName: string | null): Promise<void> {
        if (!this.#device.hasCapability('now_playing_app')) {
            return;
        }

        const currentNowPlayingApp = this.#device.getCapabilityValue('now_playing_app');

        if (currentNowPlayingApp === displayName) {
            return;
        }

        this.log(this.deviceName, 'Now playing app changed.', bundleIdentifier, displayName);

        await this.#device.setCapabilityValue('now_playing_app', displayName);

        if (this.#device instanceof AppleTVDevice) {
            await this.#device.appDriver.triggerNowPlayingAppChanges(this.#device, bundleIdentifier ?? '-', displayName ?? '-');
        }
    }
}
