import { AppleTV, type DeviceTarget, type MediaPlayback, type PowerState, type RemoteKey, type Status } from '@corewire/devices';
import { DiscoverableDevice } from '../base';
import { AirPlayLogic } from '../logic';
import { capabilityToRepeatMode, readCredentials } from '../utils';
import type AppleTVDriver from './driver';
import type Homey from 'homey';

const CAPABILITIES = [
    'speaker_album',
    'speaker_artist',
    'speaker_duration',
    'speaker_next',
    'speaker_playing',
    'speaker_position',
    'speaker_prev',
    'speaker_track',
    'speaker_repeat',
    'speaker_shuffle',
    'artwork_url',
    'artwork_url_cloud',
    'artwork_url_local',
    'onoff',
    'power',
    'volume_down',
    'volume_mute',
    'volume_set',
    'volume_up',
    'remote_up',
    'remote_down',
    'remote_left',
    'remote_right',
    'remote_select',
    'remote_home',
    'remote_back',
    'remote_playpause',
    'now_playing_app',
    'button.restart'
];

const REMOTE_KEYS: Record<string, RemoteKey> = {
    remote_up: 'up',
    remote_down: 'down',
    remote_left: 'left',
    remote_right: 'right',
    remote_select: 'select',
    remote_home: 'home',
    remote_back: 'menu',
    remote_playpause: 'playPause'
};

export default class AppleTVDevice extends DiscoverableDevice<AppleTVDriver> {
    get airplayLogic(): AirPlayLogic {
        return this.#airplayLogic;
    }

    get currentNowPlayingBundleId(): string | null {
        return this.#airplayLogic?.currentNowPlayingBundleId ?? null;
    }

    get discoveryStrategy(): Homey.DiscoveryStrategy {
        return this.discovery.getStrategy('airplay');
    }

    get isCompanionLinkConnected(): boolean {
        return this.#tv?.status.companionLink?.state === 'connected';
    }

    get sdk(): AppleTV {
        if (!this.#tv) {
            throw new Error('Apple TV SDK device is not initialized.');
        }

        return this.#tv;
    }

    #airplayLogic!: AirPlayLogic;
    #availability: string | null = null;
    #companionLinkFailed = false;
    #state: Status['state'] = 'disconnected';
    #teardown?: Promise<void>;
    #tv?: AppleTV;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#airplayLogic = new AirPlayLogic(this);
        await this.#airplayLogic.initialize();

        await this.syncCapabilities(CAPABILITIES);
        this.#registerCapabilities();
        this.#registerMaintenance();

        await super.onInit();

        this.log('Initialized.');
    }

    async onDeleted(): Promise<void> {
        await this.#dispose();
    }

    async onUninit(): Promise<void> {
        await this.#dispose();

        this.log('Uninitialized.');
    }

    async onTargetFound(target: DeviceTarget): Promise<void> {
        if (this.#tv) {
            return;
        }

        const credentials = await readCredentials(this);

        if (!credentials) {
            await this.setUnavailable('Cannot find credentials, please re-pair the device.');
            return;
        }

        this.#tv = new AppleTV(target, {
            credentials,
            log: entry => this.writeLogEntry(entry),
            resolve: () => this.resolveTarget(),
            timing: this.app.useTimingServer ? undefined : false
        });

        this.#airplayLogic.setDevice(this.#tv);
        this.#tv.on('status', status => this.#onStatus(status));
        this.#tv.power.on('change', state => this.#onPowerChanged(state));

        await this.#connect();
    }

    async playUrl(url: string, volume?: number): Promise<void> {
        // Without AirPlay the device cannot tell; the playback below then fails with the reason.
        if (this.sdk.supports('remote') && !this.sdk.supports('playUrl')) {
            throw new Error(this.homey.__('appletv.url_playback_unsupported'));
        }

        // volume_set is only present while the output device accepts absolute volume.
        if (volume !== undefined && !this.hasCapability('volume_set')) {
            throw new Error(this.homey.__('appletv.volume_not_absolute'));
        }

        const playback = await this.#startUrlPlayback(url, volume);

        // Ending the session closes the player on the Apple TV; the flow card should not wait for that.
        playback.ended.catch(err => this.error('URL playback ended with an error:', err));
    }

    async #startUrlPlayback(url: string, volume?: number): Promise<MediaPlayback> {
        try {
            if (volume !== undefined) {
                await this.sdk.volume.set(volume / 100);
            }

            return await this.sdk.media.playUrl(url);
        } catch (err) {
            this.error('Failed to start URL playback:', err);
            throw err;
        }
    }

    async #connect(): Promise<void> {
        this.log('Connecting to Apple TV...');

        try {
            await this.sdk.connect();
        } catch (err) {
            // The device keeps retrying; the status handler reports it offline.
            this.error('Error received', err);
        }
    }

    async #dispose(): Promise<void> {
        this.#teardown ??= (async () => {
            await this.#airplayLogic?.uninitialize();
            await this.#tv?.disconnect();
        })();

        await this.#teardown;
    }

    async #onStatus(status: Status): Promise<void> {
        if (status.state !== this.#state) {
            this.log(`Status ${this.#state} -> ${status.state} (${status.reason})`, status.error?.message ?? '');
            this.#state = status.state;
        }

        await this.#watchCompanionLink(status);

        try {
            await this.#updateAvailability(status);
        } catch (err) {
            this.error('Failed to update availability.', err);
        }
    }

    async #onPowerChanged(state: PowerState): Promise<void> {
        this.log('Power state changed:', state);

        const isOn = state === 'awake' || state === 'screensaver';
        const wasOff = this.getCapabilityValue('onoff') === false;

        try {
            await this.setCapabilityValue('onoff', isOn);
            await this.setCapabilityValue('power', this.homey.__(isOn ? 'capability.power.on' : 'capability.power.off'));
        } catch (err) {
            this.error('Failed to set power state.', err);
        }

        if (!isOn) {
            await this.#airplayLogic.clearNowPlaying();
            return;
        }

        // Now playing was cleared while the Apple TV was off.
        if (wasOff) {
            this.#airplayLogic.resync();
        }

        this.#airplayLogic.emitUpdate();
    }

    /**
     * Available while AirPlay is connected. Without Companion Link (`degraded`) the remote, playback,
     * volume, now playing and power on/off keep working over AirPlay, so the device stays available
     * with a warning instead.
     */
    async #updateAvailability(status: Status): Promise<void> {
        let availability: string;

        switch (status.state) {
            case 'connected':
            case 'degraded':
                availability = status.state;
                break;

            case 'recovering':
                availability = 'Disconnected from Apple TV (AirPlay), reconnecting...';
                break;

            case 'offline':
                availability = 'Device offline, retrying connection...';
                break;

            default:
                return;
        }

        if (availability === this.#availability) {
            return;
        }

        this.#availability = availability;

        if (status.state === 'connected') {
            await this.unsetWarning();
            await this.setAvailable();
        } else if (status.state === 'degraded') {
            await this.setAvailable();
            await this.setWarning('Companion Link is disconnected, reconnecting... App launching, account switching and the power state are unavailable meanwhile.');
        } else {
            await this.unsetWarning();
            await this.setUnavailable(availability);
        }
    }

    async #watchCompanionLink(status: Status): Promise<void> {
        if (status.companionLink?.phase !== 'rare') {
            this.#companionLinkFailed = false;
            return;
        }

        if (this.#companionLinkFailed) {
            return;
        }

        this.#companionLinkFailed = true;
        this.error('Companion Link keeps failing, retrying every 15 minutes...', status.companionLink.error?.message ?? '');
        await this.app.appleTvFlow.triggerCompanionLinkFailed(this);
    }

    #registerCapabilities(): void {
        this.#registerOnOff();
        this.#registerRemote();

        this.registerCapabilityListener('speaker_next', async () => {
            await this.sdk.playback.next();
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.sdk.playback.previous();
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.sdk.playback.stop();
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.sdk.playback.play();
            } else {
                await this.sdk.playback.pause();
            }
        });

        this.registerCapabilityListener('volume_set', async (volume: number) => {
            await this.sdk.volume.set(volume);
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.sdk.volume.up();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.sdk.volume.down();
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.sdk.remote.press('mute');
        });

        this.registerCapabilityListener('speaker_repeat', async (value: string) => {
            await this.sdk.playback.setRepeat(capabilityToRepeatMode[value] ?? 'off');
        });

        this.registerCapabilityListener('speaker_shuffle', async (value: boolean) => {
            await this.sdk.playback.setShuffle(value ? 'songs' : 'off');
        });
    }

    #registerMaintenance(): void {
        this.registerCapabilityListener('button.restart', async () => {
            try {
                const tv = this.#tv;

                if (!tv) {
                    await this.findTarget();
                    return;
                }

                // The device announces everything fresh after a disconnect, which fills now playing again.
                await tv.disconnect();
                await this.#airplayLogic.clearNowPlaying();
                await this.#connect();
            } catch (err) {
                this.error(err);
            }
        });
    }

    #registerOnOff(): void {
        this.registerCapabilityListener('onoff', async (value: boolean) => {
            if (!this.sdk.supports('power')) {
                throw new Error('Apple TV is not connected, cannot change the power state.');
            }

            if (value) {
                await this.sdk.power.wake();
            } else {
                await this.sdk.power.sleep();
            }
        });
    }

    #registerRemote(): void {
        this.registerMultipleCapabilityListener(Object.keys(REMOTE_KEYS), async values => {
            for (const [capability, key] of Object.entries(REMOTE_KEYS)) {
                if (values[capability] === true) {
                    await this.sdk.remote.press(key);
                }
            }
        }, 0);
    }
}
