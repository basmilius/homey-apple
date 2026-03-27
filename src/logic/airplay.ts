import { Proto } from '@basmilius/apple-airplay';
import type { AirPlayClient, AirPlayDevice, AirPlayPlayer } from '@basmilius/apple-devices';
import { type Device, Shortcuts } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import Homey from 'homey';
import AppleTVDevice from '../apple-tv/device';
import HomePodBaseDevice from '../homepod-base/device';
import { getFallbackArtworkUrl, repeatModeToCapability, safeCapabilityValue } from '../utils';

export type MiniPlayerState = {
    readonly deviceId: string;
    readonly deviceName: string;
    readonly track: string | null;
    readonly artist: string | null;
    readonly album: string | null;
    readonly playing: boolean | null;
    readonly position: number | null;
    readonly duration: number | null;
    readonly volume: number | null;
    readonly artworkUrl: string | null;
    readonly onoff: boolean | null;
    readonly shuffle: boolean;
    readonly repeat: string;
    readonly positionTimestamp: number;
    readonly features: {
        readonly previous: boolean;
        readonly next: boolean;
        readonly shuffle: boolean;
        readonly repeat: boolean;
    };
};

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
    #nowPlayingDebounceTimer?: NodeJS.Timeout;
    #nowPlayingAppTimer?: NodeJS.Timeout;
    #protocol!: AirPlayDevice;
    #updateLock: Promise<void> = Promise.resolve();
    #volumeDebounceTimer?: NodeJS.Timeout;

    constructor(device: Device<AppleApp, any>) {
        super(device.app);

        this.#device = device;
        this.onNowPlayingChanged = this.onNowPlayingChanged.bind(this);
        this.onPlaybackStateChanged = this.onPlaybackStateChanged.bind(this);
        this.onVolumeDidChange = this.onVolumeDidChange.bind(this);
        this.onVolumeMutedDidChange = this.onVolumeMutedDidChange.bind(this);
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

            if (this.#device.hasCapability('speaker_repeat')) {
                await this.#device.setCapabilityValue('speaker_repeat', 'none');
            }
            if (this.#device.hasCapability('speaker_shuffle')) {
                await this.#device.setCapabilityValue('speaker_shuffle', false);
            }

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

    getState(): MiniPlayerState {
        return {
            deviceId: this.#device.id,
            deviceName: this.#device.getName(),
            track: safeCapabilityValue(this.#device, 'speaker_track'),
            artist: safeCapabilityValue(this.#device, 'speaker_artist'),
            album: safeCapabilityValue(this.#device, 'speaker_album'),
            playing: safeCapabilityValue(this.#device, 'speaker_playing'),
            position: this.position,
            duration: safeCapabilityValue(this.#device, 'speaker_duration'),
            volume: safeCapabilityValue(this.#device, 'volume_set'),
            artworkUrl: safeCapabilityValue(this.#device, 'artwork_url'),
            onoff: safeCapabilityValue(this.#device, 'onoff'),
            shuffle: this.shuffle,
            repeat: this.repeat,
            positionTimestamp: Date.now(),
            features: this.#getFeatureAvailability(),
        };
    }

    async emitUpdate(): Promise<void> {
        await this.#emitMiniPlayerUpdate();
    }

    setProtocol(protocol: AirPlayDevice): void {
        this.#removeProtocolListeners();

        this.#protocol = protocol;
        this.#protocol.state.on('nowPlayingChanged', this.onNowPlayingChanged);
        this.#protocol.state.on('playbackStateChanged', this.onPlaybackStateChanged);
        this.#protocol.state.on('volumeDidChange', this.onVolumeDidChange);
        this.#protocol.state.on('volumeMutedDidChange', this.onVolumeMutedDidChange);
    }

    #removeProtocolListeners(): void {
        if (!this.#protocol) {
            return;
        }

        this.#protocol.state.off('nowPlayingChanged', this.onNowPlayingChanged);
        this.#protocol.state.off('playbackStateChanged', this.onPlaybackStateChanged);
        this.#protocol.state.off('volumeDidChange', this.onVolumeDidChange);
        this.#protocol.state.off('volumeMutedDidChange', this.onVolumeMutedDidChange);
    }

    async onNowPlayingChanged(client: AirPlayClient | null, _player: AirPlayPlayer | null): Promise<void> {
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

    async onPlaybackStateChanged(_client: AirPlayClient, _player: AirPlayPlayer, _oldState: Proto.PlaybackState_Enum, newState: Proto.PlaybackState_Enum): Promise<void> {
        // Fast path: update speaker_playing immediately without debounce.
        // The full nowPlayingChanged event will handle the rest.
        try {
            const isPlaying = newState === Proto.PlaybackState_Enum.Playing;
            await this.#device.setCapabilityValue('speaker_playing', isPlaying);
            await this.#emitMiniPlayerUpdate();
        } catch (err) {
            this.log(this.deviceName, 'Failed to update playback state', err);
        }
    }

    onVolumeMutedDidChange(muted: boolean): void {
        if (!this.#device.hasCapability('volume_mute')) {
            return;
        }

        this.#device.setCapabilityValue('volume_mute', muted)
            .catch(err => this.log(this.deviceName, 'Failed to update volume mute', err));
    }

    onVolumeDidChange(): void {
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

        this.log(this.deviceName, 'setArtwork', {
            artworkId,
            currentIdentifier: this.#artworkIdentifier
        });

        if (artworkId === this.#artworkIdentifier) {
            return;
        }

        // No artwork evidence at all — use fallback or clear it.
        if (!artworkId) {
            const fallbackUrl = getFallbackArtworkUrl(client.bundleIdentifier);
            this.#artworkIdentifier = undefined;
            await this.#updateArtwork(fallbackUrl);
            return;
        }

        // Use the unified artwork API to resolve artwork from all sources.
        try {
            const artwork = await this.#protocol.artwork.get(600);

            if (artwork?.url) {
                this.#artworkIdentifier = artworkId ?? undefined;
                await this.#updateArtwork(artwork.url);
            } else if (artwork?.data) {
                this.#artworkIdentifier = artworkId ?? undefined;
                await this.#updateArtworkBuffer(artwork.data);
            } else {
                this.#artworkIdentifier = artworkId ?? undefined;
                await this.#updateArtwork(null);
            }
        } catch (err) {
            this.#device.error(this.deviceName, 'Failed to fetch artwork', err);
        }
    }

    async #updateArtwork(url: string | null): Promise<void> {
        try {
            if (url) {
                this.#artwork.setUrl(url.replace('.heic', '.jpg'));
            } else {
                // @ts-expect-error The type definition of Homey.Image.setUrl() is incorrect.
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

        this.#artwork.setStream((stream: NodeJS.WritableStream) => {
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
            const hasSpeakerRepeat = device.hasCapability('speaker_repeat');
            const hasSpeakerShuffle = device.hasCapability('speaker_shuffle');
            const isNextSupported = client.isCommandSupported(Proto.Command.NextTrack);
            const isPrevSupported = client.isCommandSupported(Proto.Command.PreviousTrack);
            const isRepeatSupported = client.isCommandSupported(Proto.Command.ChangeRepeatMode);
            const isShuffleSupported = client.isCommandSupported(Proto.Command.ChangeShuffleMode);

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

            if (isRepeatSupported && !hasSpeakerRepeat) {
                await device.addCapability('speaker_repeat');
            } else if (!isRepeatSupported && hasSpeakerRepeat) {
                await device.removeCapability('speaker_repeat');
            }

            if (isShuffleSupported && !hasSpeakerShuffle) {
                await device.addCapability('speaker_shuffle');
            } else if (!isShuffleSupported && hasSpeakerShuffle) {
                await device.removeCapability('speaker_shuffle');
            }

            await device.setCapabilityValue('speaker_playing', client.isPlaying);
            await device.setCapabilityValue('speaker_album', client.album);
            await device.setCapabilityValue('speaker_artist', client.artist || client.activePlayer?.currentItemMetadata?.trackArtistName || client.displayName || '-');
            await device.setCapabilityValue('speaker_track', client.title);
            await device.setCapabilityValue('speaker_duration', client.duration);

            await device.setCapabilityValue('speaker_position', client.elapsedTime);

            if (device.hasCapability('speaker_repeat')) {
                await device.setCapabilityValue('speaker_repeat', repeatModeToCapability[this.repeat] ?? 'none');
            }
            if (device.hasCapability('speaker_shuffle')) {
                await device.setCapabilityValue('speaker_shuffle', this.shuffle);
            }

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
        try {
            await this.#device.homey.api.realtime('apple-mini-player-update', this.getState());
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
