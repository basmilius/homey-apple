import { type AbstractDevice, type AirPlayClient, type AirPlayPlayer, Proto } from '@basmilius/apple-sdk';
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
        return this.#sdkDevice?.state.elapsedTime ?? 0;
    }

    get positionTimestamp(): number {
        return Date.now();
    }

    get features(): { previous: boolean; next: boolean; shuffle: boolean; repeat: boolean } {
        return this.#getFeatureAvailability();
    }

    get repeat(): string {
        const repeatMode = this.#sdkDevice?.state.repeatMode;

        if (repeatMode === undefined) {
            return 'off';
        }

        switch (repeatMode) {
            case Proto.RepeatMode_Enum.One:
                return 'one';
            case Proto.RepeatMode_Enum.All:
                return 'all';
            default:
                return 'off';
        }
    }

    get shuffle(): boolean {
        const shuffleMode = this.#sdkDevice?.state.shuffleMode;

        if (shuffleMode === undefined) {
            return false;
        }

        return shuffleMode !== Proto.ShuffleMode_Enum.Off
            && shuffleMode !== Proto.ShuffleMode_Enum.Unknown;
    }

    readonly #device: Device<AppleApp, any>;

    #artwork!: Homey.Image;
    #artworkIdentifier?: string;
    #miniPlayerUpdateTimer?: NodeJS.Timeout;
    #nowPlayingDebounceTimer?: NodeJS.Timeout;
    #nowPlayingAppTimer?: NodeJS.Timeout;
    #sdkDevice?: AbstractDevice;
    #updateLock: Promise<void> = Promise.resolve();
    #volumeDebounceTimer?: NodeJS.Timeout;

    constructor(device: Device<AppleApp, any>) {
        super(device.app);

        this.#device = device;
        this.onNowPlayingChanged = this.onNowPlayingChanged.bind(this);
        this.onPlaybackStateChanged = this.onPlaybackStateChanged.bind(this);
        this.onVolumeChanged = this.onVolumeChanged.bind(this);
        this.onVolumeMutedChanged = this.onVolumeMutedChanged.bind(this);
        this.onArtworkChanged = this.onArtworkChanged.bind(this);
    }

    async initialize(): Promise<void> {
        await this.clearNowPlaying();

        this.#artwork = await this.#device.homey.images.createImage();
        await this.#device.setAlbumArtImage(this.#artwork);

        await this.updateArtworkUrl();
    }

    async uninitialize(): Promise<void> {
        clearTimeout(this.#miniPlayerUpdateTimer);
        clearTimeout(this.#nowPlayingDebounceTimer);
        clearTimeout(this.#nowPlayingAppTimer);
        clearTimeout(this.#volumeDebounceTimer);
        this.#removeListeners();

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

            await Promise.allSettled([
                this.#device.setCapabilityValue('speaker_album', ''),
                this.#device.setCapabilityValue('speaker_artist', ''),
                this.#device.setCapabilityValue('speaker_track', ''),
                this.#device.setCapabilityValue('speaker_duration', -1),
                this.#device.setCapabilityValue('speaker_position', -1),
                this.#device.setCapabilityValue('speaker_playing', false),
                this.#device.hasCapability('speaker_repeat') ? this.#device.setCapabilityValue('speaker_repeat', 'none') : undefined,
                this.#device.hasCapability('speaker_shuffle') ? this.#device.setCapabilityValue('speaker_shuffle', false) : undefined
            ]);
            this.#emitMiniPlayerUpdate();
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

        this.#emitMiniPlayerUpdate();
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
            features: this.#getFeatureAvailability()
        };
    }

    emitUpdate(): void {
        this.#emitMiniPlayerUpdate();
    }

    setDevice(sdkDevice: AbstractDevice): void {
        this.#removeListeners();

        this.#sdkDevice = sdkDevice;
        sdkDevice.state.on('nowPlayingChanged', this.onNowPlayingChanged);
        sdkDevice.state.on('playbackStateChanged', this.onPlaybackStateChanged);
        sdkDevice.state.on('volumeChanged', this.onVolumeChanged);
        sdkDevice.state.on('volumeMutedChanged', this.onVolumeMutedChanged);
        sdkDevice.state.on('artworkChanged', this.onArtworkChanged);
    }

    #removeListeners(): void {
        if (!this.#sdkDevice) {
            return;
        }

        this.#sdkDevice.state.off('nowPlayingChanged', this.onNowPlayingChanged);
        this.#sdkDevice.state.off('playbackStateChanged', this.onPlaybackStateChanged);
        this.#sdkDevice.state.off('volumeChanged', this.onVolumeChanged);
        this.#sdkDevice.state.off('volumeMutedChanged', this.onVolumeMutedChanged);
        this.#sdkDevice.state.off('artworkChanged', this.onArtworkChanged);
    }

    async onNowPlayingChanged(client: AirPlayClient | null, _player: AirPlayPlayer | null): Promise<void> {
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
            this.#emitMiniPlayerUpdate();
        } catch (err) {
            this.log(this.deviceName, 'Failed to update playback state', err);
        }
    }

    async onArtworkChanged(_client: AirPlayClient, _player: AirPlayPlayer): Promise<void> {
        const client = this.#sdkDevice?.state.activeClient;

        if (!client) {
            return;
        }

        // Reset the artwork identifier so that #setArtwork re-fetches even
        // if the artworkId hasn't changed (the artwork DATA has changed).
        this.#artworkIdentifier = undefined;

        await this.#serialized(async () => {
            await this.#setArtwork(client);
            this.#emitMiniPlayerUpdate();
        }).catch(err => this.log(this.deviceName, 'Failed to process artwork change:', err));
    }

    onVolumeMutedChanged(muted: boolean): void {
        if (!this.#device.hasCapability('volume_mute')) {
            return;
        }

        this.#device.setCapabilityValue('volume_mute', muted)
            .catch(err => this.log(this.deviceName, 'Failed to update volume mute', err));
    }

    onVolumeChanged(): void {
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

        const volume = this.#sdkDevice?.state.volume ?? 0;
        await this.#device.setCapabilityValue('volume_set', volume);
        this.#emitMiniPlayerUpdate();
    }

    async #setArtwork(client: AirPlayClient): Promise<void> {
        const artworkId = client.artworkId;

        if (artworkId === this.#artworkIdentifier) {
            return;
        }

        if (!artworkId) {
            this.#artworkIdentifier = undefined;
            await this.#updateArtwork(getFallbackArtworkUrl(client.bundleIdentifier));
            return;
        }

        try {
            this.#artworkIdentifier = artworkId;
            const artwork = await this.#sdkDevice?.artwork.get(600);

            if (artwork?.url) {
                await this.#updateArtwork(artwork.url);
            } else if (artwork?.data) {
                await this.#updateArtworkBuffer(artwork.data);
            } else {
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

        if (this.#isHeicBuffer(imageBuffer)) {
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
        if (this.#device.hasCapability('onoff') && this.#device.getCapabilityValue('onoff') === false) {
            return;
        }

        const client = this.#sdkDevice?.state.activeClient;

        if (!client) {
            return;
        }

        try {
            await this.#syncDynamicCapabilities(client);

            await Promise.allSettled([
                this.#device.setCapabilityValue('speaker_playing', client.isPlaying),
                this.#device.setCapabilityValue('speaker_album', client.album),
                this.#device.setCapabilityValue('speaker_artist', client.artist || client.activePlayer?.currentItemMetadata?.trackArtistName || client.displayName || '-'),
                this.#device.setCapabilityValue('speaker_track', client.title),
                this.#device.setCapabilityValue('speaker_duration', client.duration),
                this.#device.setCapabilityValue('speaker_position', client.elapsedTime)
            ]);

            if (this.#device.hasCapability('speaker_repeat')) {
                await this.#device.setCapabilityValue('speaker_repeat', repeatModeToCapability[this.repeat] ?? 'none');
            }
            if (this.#device.hasCapability('speaker_shuffle')) {
                await this.#device.setCapabilityValue('speaker_shuffle', this.shuffle);
            }

            this.#scheduleNowPlayingAppUpdate(
                client.isPlaying ? client.bundleIdentifier : null,
                client.isPlaying ? client.displayName : null
            );

            await this.#setArtwork(client);
            this.#emitMiniPlayerUpdate();
        } catch (err) {
            this.log(this.deviceName, 'Failed to update now playing info', err);
        }
    }

    async #syncDynamicCapabilities(client: AirPlayClient): Promise<void> {
        const capabilities: Array<[string, Proto.Command]> = [
            ['speaker_next', Proto.Command.NextTrack],
            ['speaker_prev', Proto.Command.PreviousTrack],
            ['speaker_repeat', Proto.Command.ChangeRepeatMode],
            ['speaker_shuffle', Proto.Command.ChangeShuffleMode]
        ];

        for (const [id, command] of capabilities) {
            const isSupported = client.isCommandSupported(command);
            const hasCapability = this.#device.hasCapability(id);

            if (isSupported && !hasCapability) {
                await this.#device.addCapability(id);
            } else if (!isSupported && hasCapability) {
                await this.#device.removeCapability(id);
            }
        }

        // Volume set is dynamically managed for Apple TV based on output device capabilities.
        if (this.#device instanceof AppleTVDevice) {
            const isVolumeAvailable = this.#sdkDevice?.state.volumeAvailable ?? false;
            const hasVolumeSet = this.#device.hasCapability('volume_set');

            if (isVolumeAvailable && !hasVolumeSet) {
                await this.#device.addCapability('volume_set');
            } else if (!isVolumeAvailable && hasVolumeSet) {
                await this.#device.removeCapability('volume_set');
            }
        }
    }

    #getFeatureAvailability(): { previous: boolean; next: boolean; shuffle: boolean; repeat: boolean } {
        const state = this.#sdkDevice?.state;

        if (!state?.activeClient) {
            return {previous: false, next: false, shuffle: false, repeat: false};
        }

        return {
            previous: state.isCommandSupported(Proto.Command.PreviousTrack),
            next: state.isCommandSupported(Proto.Command.NextTrack),
            shuffle: state.isCommandSupported(Proto.Command.ChangeShuffleMode),
            repeat: state.isCommandSupported(Proto.Command.ChangeRepeatMode)
        };
    }

    #emitMiniPlayerUpdate(): void {
        clearTimeout(this.#miniPlayerUpdateTimer);
        this.#miniPlayerUpdateTimer = setTimeout(() => {
            this.#device.homey.api.realtime('apple-mini-player-update', this.getState())
                .catch((err: unknown) => this.log(this.deviceName, 'Failed to emit mini player update:', err));
        }, 100);
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

        await this.#device.setCapabilityValue('now_playing_app', displayName);

        if (this.#device instanceof AppleTVDevice) {
            await this.app.appleTvFlow.triggerNowPlayingAppChanges(this.#device, bundleIdentifier ?? '-', displayName ?? '-');
        }
    }
}
