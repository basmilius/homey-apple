import { PassThrough } from 'node:stream';
import { Proto } from '@basmilius/apple-airplay';
import type { AirPlayClient, AirPlayDevice, AirPlayPlayer } from '@basmilius/apple-devices';
import { debounce, type Device, Shortcuts } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import Homey from 'homey';
import AppleTVDevice from '../apple-tv/device';
import HomePodBaseDevice from '../homepod-base/device';

export default class AirPlayLogic extends Shortcuts<AppleApp> {
    get deviceName(): string {
        return this.#device.name;
    }

    get position(): number {
        return this.#protocol?.state?.nowPlayingClient?.elapsedTime ?? 0;
    }

    get positionTimestamp(): number {
        return Date.now();
    }

    get features(): { previous: boolean; next: boolean; shuffle: boolean; repeat: boolean } {
        return this.#getFeatureAvailability();
    }

    get repeat(): string {
        const client = this.#protocol?.state?.nowPlayingClient;
        if (!client) {
            return 'off';
        }

        switch (client.repeatMode) {
            case Proto.RepeatMode_Enum.One:
                return 'one';
            case Proto.RepeatMode_Enum.All:
                return 'all';
            default:
                return 'off';
        }
    }

    get shuffle(): boolean {
        const client = this.#protocol?.state?.nowPlayingClient;
        if (!client) {
            return false;
        }

        return client.shuffleMode !== Proto.ShuffleMode_Enum.Off
            && client.shuffleMode !== Proto.ShuffleMode_Enum.Unknown;
    }

    readonly #device: Device<AppleApp, any>;

    #artwork!: Homey.Image;
    #artworkIdentifier?: string;
    #artworkRequestingIdentifier?: string;
    #protocol!: AirPlayDevice;

    readonly #updateNowPlayingApp: (bundleIdentifier: string | null, displayName: string | null) => Promise<void>;

    constructor(device: Device<AppleApp, any>) {
        super(device.app);

        this.#device = device;

        this.#updateNowPlayingApp = debounce(this.#updateNowPlayingAppImpl, 1000, this);
    }

    async initialize(): Promise<void> {
        await this.clearNowPlaying();

        this.#artwork = await this.#device.homey.images.createImage();
        await this.#device.setAlbumArtImage(this.#artwork);

        await this.updateArtworkUrl();
    }

    async uninitialize(): Promise<void> {
        this.#protocol.state.removeAllListeners();
        await this.#artwork.unregister();
    }

    async clearNowPlaying(): Promise<void> {
        try {
            if (this.#artwork) {
                this.#artworkIdentifier = undefined;
                await this.#updateArtwork(null);
                await this.#updateNowPlayingApp(null, null);
            }

            await this.#device.setCapabilityValue('speaker_album', '');
            await this.#device.setCapabilityValue('speaker_artist', '');
            await this.#device.setCapabilityValue('speaker_track', '');
            await this.#device.setCapabilityValue('speaker_duration', -1);
            await this.#device.setCapabilityValue('speaker_position', -1);
            await this.#device.setCapabilityValue('speaker_playing', false);

            this.log(this.deviceName, 'Now playing info cleared.');
            await this.#emitMiniPlayerUpdate();
        } catch (err) {
            this.log(this.deviceName, 'Failed to clear now playing info', err);
        }
    }

    async updateArtworkUrl(): Promise<void> {
        if (!this.#device.hasCapability('artwork_url')) {
            return;
        }

        // @ts-expect-error The type definition for Homey.Image.cloudUrl does not exist, but the property is there.
        const cloudUrl = this.#artwork.cloudUrl;

        if (!cloudUrl) {
            return;
        }

        const cacheBuster = new Date().getTime();
        const artworkUrl = `${cloudUrl}?v=${cacheBuster}`;
        await this.#device.setCapabilityValue('artwork_url', artworkUrl);
        this.log(this.deviceName, 'Artwork URL updated.', artworkUrl);

        // @ts-expect-error The type definition for Homey.Image.localUrl does not exist, but the property is there.
        const localUrl = this.#artwork.localUrl;
        const localUrlWithCacheBuster = localUrl ? `${localUrl}?v=${cacheBuster}` : '';

        if (this.#device.hasCapability('artwork_url_cloud')) {
            await this.#device.setCapabilityValue('artwork_url_cloud', artworkUrl);
        }

        if (this.#device.hasCapability('artwork_url_local')) {
            await this.#device.setCapabilityValue('artwork_url_local', localUrlWithCacheBuster);
        }

        if (this.#device instanceof AppleTVDevice) {
            await this.app.appleTvFlow.triggerArtworkUrlUpdated(this.#device, localUrlWithCacheBuster, artworkUrl);
        } else if (this.#device instanceof HomePodBaseDevice) {
            await this.app.homePodFlow.triggerArtworkUrlUpdated(this.#device, localUrlWithCacheBuster, artworkUrl);
        }

        await this.#emitMiniPlayerUpdate();
    }

    setProtocol(protocol: AirPlayDevice): void {
        this.#protocol = protocol;

        this.#protocol.state.on('nowPlayingChanged', this.#onNowPlayingChanged.bind(this));
        this.#protocol.state.on('volumeDidChange', async () => await this.#onVolumeDidChange());
    }

    async #onNowPlayingChanged(client: AirPlayClient | null, _player: AirPlayPlayer | null): Promise<void> {
        this.log(this.deviceName, `Now playing changed.`, client?.bundleIdentifier, client?.title);

        if (!client) {
            await this.clearNowPlaying();
            return;
        }

        await this.#updateNowPlaying();
    }

    async #onVolumeDidChange(): Promise<void> {
        try {
            if (!this.#device.hasCapability('volume_set')) {
                return;
            }

            this.log(this.deviceName, `Volume changed to ${this.#protocol.state.volume}.`);
            await this.#device.setCapabilityValue('volume_set', this.#protocol.state.volume);
            await this.#emitMiniPlayerUpdate();
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

        if (!item.metadata?.artworkAvailable) {
            this.log(this.deviceName, 'Artwork not available.');
            await this.#updateArtwork(null);
            return;
        }

        if (item.metadata?.artworkURL) {
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
            await this.updateArtworkUrl();
        } catch (err) {
            this.log(this.deviceName, 'Failed to update album artwork', err);
        }
    }

    async #updateArtworkBuffer(buffer: Uint8Array<ArrayBufferLike> | Buffer): Promise<void> {
        await this.#device.setAlbumArtImage(this.#artwork);
        this.#artwork.setStream((stream: any) => {
            const pt = new PassThrough();
            pt.end(buffer);
            pt.pipe(stream);
        });
        await this.#artwork.update();
        await this.updateArtworkUrl();
    }

    async #updateNowPlaying(): Promise<void> {
        // note: Do not update now playing info if the device is turned off.
        if (this.#device.hasCapability('onoff') && this.#device.getCapabilityValue('onoff') === false) {
            return;
        }

        const client = this.#protocol.state.nowPlayingClient;
        const device = this.#device;
        const item = client?.currentItem ?? null;

        this.log(this.deviceName, 'Now playing info updated.', client?.bundleIdentifier, client?.title);

        if (!client) {
            return;
        }

        try {
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

            await device.setCapabilityValue('speaker_playing', client.isPlaying);
            await device.setCapabilityValue('speaker_album', client.album);
            await device.setCapabilityValue('speaker_artist', client.artist || client.displayName || '-');
            await device.setCapabilityValue('speaker_track', client.title);
            await device.setCapabilityValue('speaker_duration', client.duration);

            await device.setCapabilityValue('speaker_position', client.elapsedTime);

            const nowPlayingAppBundleIdentifier = client.isPlaying ? client.bundleIdentifier : null;
            const nowPlayingAppDisplayName = client.isPlaying ? client.displayName : null;

            await this.#updateNowPlayingApp(nowPlayingAppBundleIdentifier, nowPlayingAppDisplayName);

            if (item) {
                await this.#setArtwork(item.metadata?.artworkIdentifier || item.metadata?.contentIdentifier || item.identifier, item);
            }

            await this.#emitMiniPlayerUpdate();
        } catch (err) {
            this.log(this.deviceName, 'Failed to update now playing info', err);
        }
    }

    #getFeatureAvailability(): { previous: boolean; next: boolean; shuffle: boolean; repeat: boolean } {
        const client = this.#protocol?.state?.nowPlayingClient;

        if (!client) {
            return {previous: false, next: false, shuffle: false, repeat: false};
        }

        return {
            previous: client.isCommandSupported(Proto.Command.PreviousTrack),
            next: client.isCommandSupported(Proto.Command.NextTrack),
            shuffle: client.isCommandSupported(Proto.Command.ChangeShuffleMode),
            repeat: client.isCommandSupported(Proto.Command.ChangeRepeatMode),
        };
    }

    async #emitMiniPlayerUpdate(): Promise<void> {
        const cap = (name: string): any => {
            try {
                return this.#device.getCapabilityValue(name);
            } catch {
                return null;
            }
        };

        try {
            await this.#device.homey.api.realtime('apple-mini-player-update', {
                deviceId: this.#device.id,
                deviceName: this.#device.getName(),
                track: cap('speaker_track'),
                artist: cap('speaker_artist'),
                album: cap('speaker_album'),
                playing: cap('speaker_playing'),
                position: this.position,
                duration: cap('speaker_duration'),
                volume: cap('volume_set'),
                artworkUrl: cap('artwork_url'),
                onoff: cap('onoff'),
                shuffle: this.shuffle,
                repeat: this.repeat,
                positionTimestamp: Date.now(),
                features: this.#getFeatureAvailability(),
            });
        } catch (err) {
            this.log(this.deviceName, 'Failed to emit mini player update:', err);
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
            await this.app.appleTvFlow.triggerNowPlayingAppChanges(this.#device, bundleIdentifier ?? '-', displayName ?? '-');
        }
    }
}
