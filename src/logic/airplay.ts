import { Proto } from '@basmilius/apple-airplay';
import type { AirPlayClient, AirPlayDevice, AirPlayPlayer } from '@basmilius/apple-devices';
import { type Device, Shortcuts } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import Homey from 'homey';
import AppleTVDevice from '../apple-tv/device';
import HomePodBaseDevice from '../homepod-base/device';
import { getFallbackArtworkUrl } from '../utils';

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
    #boundOnNowPlayingChanged?: (...args: any[]) => void;
    #boundOnVolumeDidChange?: () => void;
    #nowPlayingDebounceTimer?: NodeJS.Timeout;
    #nowPlayingAppTimer?: NodeJS.Timeout;
    #protocol!: AirPlayDevice;
    #updateLock: Promise<void> = Promise.resolve();
    #volumeDebounceTimer?: NodeJS.Timeout;

    constructor(device: Device<AppleApp, any>) {
        super(device.app);

        this.#device = device;
    }

    async initialize(): Promise<void> {
        await this.clearNowPlaying();

        this.#artwork = await this.#device.homey.images.createImage();
        await this.#device.setAlbumArtImage(this.#artwork);

        await this.updateArtworkUrl();
    }

    async uninitialize(): Promise<void> {
        clearTimeout(this.#nowPlayingDebounceTimer);
        clearTimeout(this.#nowPlayingAppTimer);
        clearTimeout(this.#volumeDebounceTimer);
        this.#removeProtocolListeners();

        try {
            await this.#artwork.unregister();
        } catch (err) {
            this.log(this.deviceName, 'Failed to unregister artwork image:', err);
        }
    }

    async clearNowPlaying(): Promise<void> {
        await this.#serialized(() => this.#clearNowPlayingImpl());
    }

    async #clearNowPlayingImpl(): Promise<void> {
        try {
            if (this.#artwork) {
                this.#artworkIdentifier = undefined;
                await this.#updateArtwork(null);
            }

            clearTimeout(this.#nowPlayingAppTimer);
            await this.#updateNowPlayingAppImpl(null, null);

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

    async emitUpdate(): Promise<void> {
        await this.#emitMiniPlayerUpdate();
    }

    setProtocol(protocol: AirPlayDevice): void {
        this.#removeProtocolListeners();

        this.#protocol = protocol;

        this.#boundOnNowPlayingChanged = this.#onNowPlayingChanged.bind(this);
        this.#boundOnVolumeDidChange = () => this.#onVolumeDidChange();

        this.#protocol.state.on('nowPlayingChanged', this.#boundOnNowPlayingChanged);
        this.#protocol.state.on('volumeDidChange', this.#boundOnVolumeDidChange);
    }

    #removeProtocolListeners(): void {
        if (!this.#protocol) {
            return;
        }

        if (this.#boundOnNowPlayingChanged) {
            this.#protocol.state.off('nowPlayingChanged', this.#boundOnNowPlayingChanged);
        }

        if (this.#boundOnVolumeDidChange) {
            this.#protocol.state.off('volumeDidChange', this.#boundOnVolumeDidChange);
        }
    }

    async #onNowPlayingChanged(client: AirPlayClient | null, _player: AirPlayPlayer | null): Promise<void> {
        this.log(this.deviceName, `Now playing changed.`, client?.bundleIdentifier, client?.title);

        clearTimeout(this.#nowPlayingDebounceTimer);
        this.#nowPlayingDebounceTimer = setTimeout(() => {
            this.#serialized(async () => {
                if (!client) {
                    await this.#clearNowPlayingImpl();
                    return;
                }

                await this.#updateNowPlaying();
            }).catch(err => this.log(this.deviceName, 'Failed to process now playing change:', err));
        }, 300);
    }

    #onVolumeDidChange(): void {
        clearTimeout(this.#volumeDebounceTimer);
        this.#volumeDebounceTimer = setTimeout(() => {
            this.#updateVolume()
                .catch(err => this.log(this.deviceName, 'Failed to update volume:', err));
        }, 300);
    }

    async #updateVolume(): Promise<void> {
        if (!this.#device.hasCapability('volume_set')) {
            return;
        }

        this.log(this.deviceName, `Volume changed to ${this.#protocol.state.volume}.`);
        await this.#device.setCapabilityValue('volume_set', this.#protocol.state.volume);
        await this.#emitMiniPlayerUpdate();
    }

    async #setArtwork(client: AirPlayClient): Promise<void> {
        const artworkId = client.artworkId;
        const url = client.artworkUrl(600);
        const data = client.currentItemArtwork;

        this.log(this.deviceName, 'setArtwork', {
            artworkId,
            currentIdentifier: this.#artworkIdentifier,
            hasUrl: !!url,
            hasData: !!data,
            url: url?.substring(0, 80)
        });

        if (artworkId === this.#artworkIdentifier) {
            return;
        }

        // Priority 1: URL (artworkURL, remoteArtworks, artworkIdentifier template).
        if (url) {
            this.#artworkIdentifier = artworkId ?? undefined;
            await this.#updateArtwork(url);
            return;
        }

        // Priority 2: Inline binary data from playback queue.
        if (data) {
            this.#artworkIdentifier = artworkId ?? undefined;
            await this.#updateArtworkBuffer(data);
            return;
        }

        // No artwork evidence at all — use fallback or clear it.
        if (!artworkId) {
            const fallbackUrl = getFallbackArtworkUrl(client.bundleIdentifier);
            this.#artworkIdentifier = undefined;
            await this.#updateArtwork(fallbackUrl);
            return;
        }

        // Artwork should be available but isn't yet — request playback queue.
        if (this.#artworkRequestingIdentifier === artworkId) {
            return;
        }

        try {
            this.log(this.deviceName, 'Requesting artwork from playback queue...', artworkId);
            this.#artworkRequestingIdentifier = artworkId ?? undefined;
            await this.#updateArtwork(null);
            await this.#protocol.requestPlaybackQueue(1);
        } catch (err) {
            this.#artworkRequestingIdentifier = undefined;
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
        const imageBuffer = Buffer.from(buffer);
        this.log(this.deviceName, `Artwork buffer size: ${imageBuffer.byteLength}, header: ${imageBuffer.subarray(0, 12).toString('hex')}`);

        if (this.#isHeicBuffer(imageBuffer)) {
            this.log(this.deviceName, 'Skipping HEIC/HEIF artwork (not supported by Homey).');
            return;
        }

        this.#artwork.setStream((stream: any) => {
            stream.end(imageBuffer);
        });
        await this.#artwork.update();
        await this.updateArtworkUrl();
    }

    #isHeicBuffer(buffer: Buffer): boolean {
        if (buffer.byteLength < 12) {
            return false;
        }

        const ftyp = buffer.subarray(4, 8).toString('ascii');

        if (ftyp !== 'ftyp') {
            return false;
        }

        const brand = buffer.subarray(8, 12).toString('ascii');
        return ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1'].includes(brand);
    }

    async #updateNowPlaying(): Promise<void> {
        // note: Do not update now playing info if the device is turned off.
        if (this.#device.hasCapability('onoff') && this.#device.getCapabilityValue('onoff') === false) {
            return;
        }

        const client = this.#protocol.state.nowPlayingClient;
        const device = this.#device;

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
            await device.setCapabilityValue('speaker_artist', client.artist || client.activePlayer?.currentItemMetadata?.trackArtistName || client.displayName || '-');
            await device.setCapabilityValue('speaker_track', client.title);
            await device.setCapabilityValue('speaker_duration', client.duration);

            await device.setCapabilityValue('speaker_position', client.elapsedTime);

            const nowPlayingAppBundleIdentifier = client.isPlaying ? client.bundleIdentifier : null;
            const nowPlayingAppDisplayName = client.isPlaying ? client.displayName : null;

            this.#scheduleNowPlayingAppUpdate(nowPlayingAppBundleIdentifier, nowPlayingAppDisplayName);

            await this.#setArtwork(client);

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

    async #serialized(fn: () => Promise<void>): Promise<void> {
        let releaseLock: () => void;
        const newLock = new Promise<void>(resolve => {
            releaseLock = resolve;
        });

        const previousLock = this.#updateLock;
        this.#updateLock = newLock;

        await previousLock;

        try {
            await fn();
        } finally {
            releaseLock!();
        }
    }

    #scheduleNowPlayingAppUpdate(bundleIdentifier: string | null, displayName: string | null): void {
        clearTimeout(this.#nowPlayingAppTimer);
        this.#nowPlayingAppTimer = setTimeout(() => {
            this.#updateNowPlayingAppImpl(bundleIdentifier, displayName)
                .catch(err => this.log(this.deviceName, 'Failed to update now playing app', err));
        }, 1000);
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
