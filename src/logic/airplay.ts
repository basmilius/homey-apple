import type { AppleDevice, NowPlaying, NowPlayingCommand, PlaybackState, VolumeState } from '@corewire/devices';
import { fetchAnimatedArtwork } from '@corewire/devices/catalog';
import { type Device, Shortcuts } from '@basmilius/homey-common';
import AppleTVDevice from '../apple-tv/device';
import HomePodBaseDevice from '../homepod-base/device';
import type { AppleApp } from '../types';
import { getFallbackArtworkUrl, repeatModeToCapability, safeCapabilityValue } from '../utils';
import { AnimatedArtworkCache } from '../utils/animatedArtworkCache';
import type Homey from 'homey';

const ARTWORK_DOWNLOAD_TIMEOUT = 5000;
const MAX_ARTWORK_SIZE = 4 * 1024 * 1024;

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
    readonly artworkLocalUrl: string | null;
    readonly artworkSourceUrl: string | null;
    readonly animatedArtworkUrl: string | null;
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
        return this.#sdkDevice?.nowPlaying.elapsed ?? 0;
    }

    get positionTimestamp(): number {
        return Date.now();
    }

    get features(): { previous: boolean; next: boolean; shuffle: boolean; repeat: boolean } {
        return this.#getFeatureAvailability();
    }

    get repeat(): string {
        return this.#sdkDevice?.nowPlaying.current?.repeat ?? 'off';
    }

    get shuffle(): boolean {
        return (this.#sdkDevice?.nowPlaying.current?.shuffle ?? 'off') !== 'off';
    }

    get currentNowPlayingBundleId(): string | null {
        return this.#currentNowPlayingBundleId;
    }

    readonly #device: Device<AppleApp, any>;

    #artwork!: Homey.Image;
    #artworkIdentifier?: string;
    #artworkLocalUrl: string | null = null;
    #artworkSourceUrl: string | null = null;
    readonly #animatedArtworkCache = new AnimatedArtworkCache();
    #animatedArtworkUrl: string | null = null;
    #animatedArtworkRequest = 0;
    #animatedArtworkKey: string | null = null;
    #animatedArtworkTrackKey: string | null = null;
    #currentNowPlayingBundleId: string | null = null;
    #muted?: boolean;
    #playingBundleId: string | null = null;
    #miniPlayerUpdateTimer?: NodeJS.Timeout;
    #nowPlayingDebounceTimer?: NodeJS.Timeout;
    #nowPlayingAppTimer?: NodeJS.Timeout;
    #sdkDevice?: AppleDevice<any>;
    #updateLock: Promise<void> = Promise.resolve();
    #volumeDebounceTimer?: NodeJS.Timeout;

    constructor(device: Device<AppleApp, any>) {
        super(device.app);

        this.#device = device;
        this.onNowPlayingChanged = this.onNowPlayingChanged.bind(this);
        this.onPlaybackStateChanged = this.onPlaybackStateChanged.bind(this);
        this.onVolumeChanged = this.onVolumeChanged.bind(this);
        this.onArtworkChanged = this.onArtworkChanged.bind(this);
    }

    async initialize(): Promise<void> {
        await this.clearNowPlaying();

        this.#artwork = await this.#device.homey.images.createImage();
        await this.#device.setAlbumArtImage(this.#artwork);

        await this.updateArtworkUrl();
    }

    async uninitialize(): Promise<void> {
        this.#resetAnimatedArtwork();
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
        this.#resetAnimatedArtwork();

        try {
            if (this.#artwork) {
                this.#artworkIdentifier = undefined;
                await this.#updateArtwork(null);
            }

            clearTimeout(this.#nowPlayingAppTimer);
            await this.#updatePlayingApp(null);
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
        this.#artworkLocalUrl = localUrlWithCacheBuster || null;

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
        this.#refreshAnimatedArtwork();

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
            artworkLocalUrl: this.#artworkLocalUrl,
            artworkSourceUrl: this.#artworkSourceUrl,
            animatedArtworkUrl: this.#animatedArtworkUrl,
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

    setDevice(sdkDevice: AppleDevice<any>): void {
        this.#resetAnimatedArtwork();
        this.#removeListeners();

        this.#sdkDevice = sdkDevice;
        sdkDevice.nowPlaying.on('change', this.onNowPlayingChanged);
        sdkDevice.nowPlaying.on('state', this.onPlaybackStateChanged);
        sdkDevice.nowPlaying.on('artwork', this.onArtworkChanged);
        sdkDevice.volume.on('change', this.onVolumeChanged);
    }

    /**
     * Fills now playing and the volume from what the device holds now. The device only announces
     * changes, so after the app cleared the capabilities itself an unchanged item would stay empty.
     */
    resync(): void {
        const sdkDevice = this.#sdkDevice;

        if (!sdkDevice) {
            return;
        }

        void this.onNowPlayingChanged(sdkDevice.nowPlaying.current);
        this.onVolumeChanged(sdkDevice.volume);
    }

    #removeListeners(): void {
        if (!this.#sdkDevice) {
            return;
        }

        this.#sdkDevice.nowPlaying.off('change', this.onNowPlayingChanged);
        this.#sdkDevice.nowPlaying.off('state', this.onPlaybackStateChanged);
        this.#sdkDevice.nowPlaying.off('artwork', this.onArtworkChanged);
        this.#sdkDevice.volume.off('change', this.onVolumeChanged);
    }

    async onNowPlayingChanged(item: NowPlaying | null): Promise<void> {
        const trackKey = item ? JSON.stringify([item.app.bundleId, item.artist, item.album, item.title, item.storeAlbumId ?? '']) : null;

        if (trackKey !== this.#animatedArtworkTrackKey) {
            this.#resetAnimatedArtwork();
            this.#animatedArtworkTrackKey = trackKey;
        }

        clearTimeout(this.#nowPlayingDebounceTimer);
        this.#nowPlayingDebounceTimer = setTimeout(() => {
            this.#serialized(async () => {
                if (!item) {
                    await this.#clearNowPlayingImpl();
                    return;
                }

                await this.#updateNowPlaying();
            }).catch(err => this.log(this.deviceName, 'Failed to process now playing change:', err));
        }, 300);
    }

    async onPlaybackStateChanged(state: PlaybackState, _previous: PlaybackState, item: NowPlaying): Promise<void> {
        // Sets speaker_playing without the debounce; the now playing change that follows does the rest.
        try {
            const isPlaying = state === 'playing';
            await this.#updateNowPlayingApp(item, isPlaying);
            await this.#device.setCapabilityValue('speaker_playing', isPlaying);
            this.#emitMiniPlayerUpdate();
        } catch (err) {
            this.log(this.deviceName, 'Failed to update playback state', err);
        }
    }

    async onArtworkChanged(): Promise<void> {
        const client = this.#sdkDevice?.nowPlaying.current;

        if (!client) {
            return;
        }

        // The image changed under the same artworkId, so #setArtwork has to fetch it again.
        this.#artworkIdentifier = undefined;

        await this.#serialized(async () => {
            await this.#setArtwork(client);
            this.#refreshAnimatedArtwork();
            this.#emitMiniPlayerUpdate();
        }).catch(err => this.log(this.deviceName, 'Failed to process artwork change:', err));
    }

    onVolumeChanged(volume: VolumeState): void {
        if (volume.muted !== this.#muted) {
            this.#muted = volume.muted;
            this.#updateMuted(volume.muted);
        }

        clearTimeout(this.#volumeDebounceTimer);

        this.#volumeDebounceTimer = setTimeout(() => {
            this.#updateVolume()
                .catch(err => this.log(this.deviceName, 'Failed to update volume:', err));
        }, 300);
    }

    #updateMuted(muted: boolean): void {
        if (!this.#device.hasCapability('volume_mute')) {
            return;
        }

        this.#device.setCapabilityValue('volume_mute', muted)
            .catch(err => this.log(this.deviceName, 'Failed to update volume mute', err));
    }

    async #updateVolume(): Promise<void> {
        if (!this.#device.hasCapability('volume_set')) {
            return;
        }

        const volume = this.#sdkDevice?.volume.level ?? 0;
        await this.#device.setCapabilityValue('volume_set', volume);
        this.#emitMiniPlayerUpdate();
    }

    async #setArtwork(item: NowPlaying): Promise<void> {
        const artworkId = item.artworkId;

        if (artworkId === this.#artworkIdentifier) {
            return;
        }

        if (!artworkId) {
            this.#artworkIdentifier = undefined;
            await this.#updateArtwork(getFallbackArtworkUrl(item.app.bundleId));
            return;
        }

        // Artwork comes over AirPlay; while it is down the lookup throws. Retry on a later event.
        if (!this.#sdkDevice?.supports('artwork')) {
            this.#artworkIdentifier = undefined;
            return;
        }

        try {
            const artwork = await this.#sdkDevice.artwork.get(600);

            if (artwork?.url) {
                this.#artworkIdentifier = artworkId;
                await this.#updateArtwork(artwork.url);
            } else if (artwork?.data) {
                this.#artworkIdentifier = artworkId;
                await this.#updateArtworkBuffer(artwork.data);
            } else {
                // The artwork url can follow the artworkId in a later update. Keep the current image;
                // the unset identifier makes the next event retry.
                this.#artworkIdentifier = undefined;
            }
        } catch (err) {
            this.#artworkIdentifier = undefined;
            this.#device.error(this.deviceName, 'Failed to fetch artwork', err);
        }
    }

    #resetAnimatedArtwork(): void {
        this.#animatedArtworkRequest++;
        this.#animatedArtworkKey = null;
        this.#animatedArtworkTrackKey = null;
        this.#setAnimatedArtworkUrl(null);
    }

    #setAnimatedArtworkUrl(url: string | null): void {
        this.#animatedArtworkUrl = url;

        if (!this.#device.hasCapability('artwork_animated_url')) {
            return;
        }

        this.#device.setCapabilityValue('artwork_animated_url', url)
            .catch((err: unknown) => this.log(this.deviceName, 'Failed to update animated artwork:', err));
    }

    #refreshAnimatedArtwork(): void {
        const sdkDevice = this.#sdkDevice;
        const client = sdkDevice?.nowPlaying.current;

        if (!sdkDevice || !client) {
            this.#resetAnimatedArtwork();
            return;
        }

        // Metadata arrives in pieces, so an incomplete item says nothing about the track that
        // is playing. onNowPlayingChanged owns the reset, by comparing the whole track key.
        if (client.title !== safeCapabilityValue(this.#device, 'speaker_track')) {
            return;
        }

        // Apple leaves the album name empty for plenty of sources. The catalog lookup keys on
        // the album id, so only compare the name when the device actually reports one.
        if (client.album && client.album !== safeCapabilityValue(this.#device, 'speaker_album')) {
            return;
        }

        const key = client.storeAlbumId;

        if (!key) {
            return;
        }

        const requestKey = `${key}:${Math.floor(Date.now() / 60_000)}`;

        if (requestKey === this.#animatedArtworkKey) {
            return;
        }

        this.#animatedArtworkKey = requestKey;
        const request = ++this.#animatedArtworkRequest;

        void this.#animatedArtworkCache.get(key, async () => {
            if (sdkDevice.nowPlaying.current?.storeAlbumId !== key) {
                return null;
            }

            const artworks = await fetchAnimatedArtwork(key);

            // The album may have changed during the lookup.
            if (sdkDevice.nowPlaying.current?.storeAlbumId !== key) {
                return null;
            }

            const url = artworks.find(artwork => artwork.format === 'motionDetailSquare')?.url;

            return url?.startsWith('https://') ? url : null;
        }).then(url => {
            if (request !== this.#animatedArtworkRequest || sdkDevice !== this.#sdkDevice) {
                return;
            }

            if (this.#animatedArtworkUrl !== url) {
                this.#setAnimatedArtworkUrl(url);
                this.#emitMiniPlayerUpdate();
            }
        }).catch(error => this.log(this.deviceName, 'Failed to fetch animated artwork:', error));
    }

    async #updateArtwork(url: string | null): Promise<void> {
        try {
            const sourceUrl = url?.replace('.heic', '.jpg') ?? null;
            this.#artworkSourceUrl = sourceUrl;

            if (sourceUrl) {
                this.#artwork.setUrl(sourceUrl);
            } else {
                // @ts-expect-error The type definition of Homey.Image.setUrl() is incorrect.
                this.#artwork.setUrl(null);
            }

            await this.#artwork.update();
            await this.updateArtworkUrl();

            if (sourceUrl) {
                void this.#bufferArtwork(sourceUrl);
            }
        } catch (err) {
            this.log(this.deviceName, 'Failed to update album artwork', err);
        }
    }

    /**
     * Swaps the remote url for the downloaded bytes, so Homey serves the artwork from memory
     * instead of fetching it upstream for every viewer. Deliberately not awaited: the url is
     * already published, and the download may not hold up the now playing update.
     */
    async #bufferArtwork(sourceUrl: string): Promise<void> {
        const buffer = await this.#downloadArtwork(sourceUrl);

        if (!buffer || sourceUrl !== this.#artworkSourceUrl) {
            return;
        }

        try {
            this.#artwork.setStream((stream: NodeJS.WritableStream) => {
                stream.end(buffer);
            });

            // The url stays the same, so viewers keep the copy they already have.
            await this.#artwork.update();
        } catch (err) {
            this.log(this.deviceName, 'Failed to cache album artwork', err);
        }
    }

    async #downloadArtwork(url: string): Promise<Buffer | null> {
        try {
            const response = await fetch(url, {signal: AbortSignal.timeout(ARTWORK_DOWNLOAD_TIMEOUT)});

            if (!response.ok) {
                await response.body?.cancel();
                return null;
            }

            const contentLength = Number(response.headers.get('content-length'));

            if (contentLength > MAX_ARTWORK_SIZE) {
                await response.body?.cancel();
                return null;
            }

            const buffer = Buffer.from(await response.arrayBuffer());

            if (buffer.byteLength > MAX_ARTWORK_SIZE || this.#isHeicBuffer(buffer)) {
                return null;
            }

            return buffer;
        } catch (err) {
            this.log(this.deviceName, 'Failed to download album artwork', err);
            return null;
        }
    }

    async #updateArtworkBuffer(buffer: Uint8Array<ArrayBufferLike> | Buffer): Promise<void> {
        const imageBuffer = Buffer.from(buffer);

        if (this.#isHeicBuffer(imageBuffer)) {
            return;
        }

        this.#artworkSourceUrl = null;

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

        const nowPlaying = this.#sdkDevice?.nowPlaying;
        const client = nowPlaying?.current;

        if (!client) {
            return;
        }

        try {
            const isPlaying = client.state === 'playing';

            await this.#syncDynamicCapabilities();
            await this.#updateNowPlayingApp(client, isPlaying);

            await Promise.allSettled([
                this.#device.setCapabilityValue('speaker_playing', isPlaying),
                this.#device.setCapabilityValue('speaker_album', client.album),
                this.#device.setCapabilityValue('speaker_artist', client.artist || client.trackArtist || client.app.name || '-'),
                this.#device.setCapabilityValue('speaker_track', client.title),
                this.#device.setCapabilityValue('speaker_duration', client.duration),
                this.#device.setCapabilityValue('speaker_position', nowPlaying.elapsed)
            ]);

            if (this.#device.hasCapability('speaker_repeat')) {
                await this.#device.setCapabilityValue('speaker_repeat', repeatModeToCapability[this.repeat] ?? 'none');
            }

            if (this.#device.hasCapability('speaker_shuffle')) {
                await this.#device.setCapabilityValue('speaker_shuffle', this.shuffle);
            }

            await this.#setArtwork(client);
            this.#refreshAnimatedArtwork();
            this.#emitMiniPlayerUpdate();
        } catch (err) {
            this.log(this.deviceName, 'Failed to update now playing info', err);
        }
    }

    async #syncDynamicCapabilities(): Promise<void> {
        const sdkDevice = this.#sdkDevice;

        if (!sdkDevice) {
            return;
        }

        const capabilities: Array<[string, NowPlayingCommand]> = [
            ['speaker_next', 'next'],
            ['speaker_prev', 'previous'],
            ['speaker_repeat', 'repeat'],
            ['speaker_shuffle', 'shuffle']
        ];

        for (const [id, command] of capabilities) {
            const isSupported = sdkDevice.nowPlaying.supports(command);
            const hasCapability = this.#device.hasCapability(id);

            if (isSupported && !hasCapability) {
                await this.#device.addCapability(id);
            } else if (!isSupported && hasCapability) {
                await this.#device.removeCapability(id);
            }
        }

        // Devices paired before this capability existed receive it here.
        if (!this.#device.hasCapability('artwork_animated_url')) {
            await this.#device.addCapability('artwork_animated_url');
        }

        // An Apple TV has volume_set only while its output accepts an absolute volume.
        if (this.#device instanceof AppleTVDevice) {
            const isVolumeAvailable = sdkDevice.volume.available;
            const isVolumeAbsolute = sdkDevice.volume.mode === 'absolute';
            const hasVolumeSet = this.#device.hasCapability('volume_set');

            if (isVolumeAvailable && isVolumeAbsolute) {
                if (!hasVolumeSet) {
                    await this.#device.addCapability('volume_set');
                }
            } else {
                await this.#device.removeCapability('volume_set');
            }
        }
    }

    #getFeatureAvailability(): { previous: boolean; next: boolean; shuffle: boolean; repeat: boolean } {
        const nowPlaying = this.#sdkDevice?.nowPlaying;

        if (!nowPlaying?.current) {
            return {previous: false, next: false, shuffle: false, repeat: false};
        }

        return {
            previous: nowPlaying.supports('previous'),
            next: nowPlaying.supports('next'),
            shuffle: nowPlaying.supports('shuffle'),
            repeat: nowPlaying.supports('repeat')
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

    // A flow started by speaker_playing checks the now playing app, so a playing app is set before it.
    // Only clearing the app is debounced, so a short pause does not flap it.
    async #updateNowPlayingApp(item: NowPlaying, isPlaying: boolean): Promise<void> {
        await this.#updatePlayingApp(isPlaying ? item.app.bundleId : null);

        if (!isPlaying) {
            this.#scheduleNowPlayingAppUpdate(null, null);
            return;
        }

        clearTimeout(this.#nowPlayingAppTimer);
        await this.#updateNowPlayingAppImpl(item.app.bundleId, item.app.name);
    }

    // Unlike now_playing_app, this follows playback without a debounce, so a pause stops the app.
    async #updatePlayingApp(bundleIdentifier: string | null): Promise<void> {
        const previous = this.#playingBundleId;

        if (previous === bundleIdentifier || !(this.#device instanceof AppleTVDevice)) {
            return;
        }

        this.#playingBundleId = bundleIdentifier;

        if (previous) {
            await this.app.appleTvFlow.triggerAppPlayback(this.#device, 'appletv_app_stops_playing', previous);
        }

        if (bundleIdentifier) {
            await this.app.appleTvFlow.triggerAppPlayback(this.#device, 'appletv_app_starts_playing', bundleIdentifier);
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
        const bundleIdChanged = this.#currentNowPlayingBundleId !== bundleIdentifier;

        if (currentNowPlayingApp === displayName && !bundleIdChanged) {
            return;
        }

        this.#currentNowPlayingBundleId = bundleIdentifier;
        await this.#device.setCapabilityValue('now_playing_app', displayName);

        if (this.#device instanceof AppleTVDevice) {
            await this.app.appleTvFlow.triggerNowPlayingAppChanges(this.#device, bundleIdentifier ?? '-', displayName ?? '-');

            if (bundleIdChanged && bundleIdentifier) {
                await this.app.appleTvFlow.triggerNowPlayingAppBecomes(this.#device, bundleIdentifier, displayName ?? '-');
            }
        }
    }
}
