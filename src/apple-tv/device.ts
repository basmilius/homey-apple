import { AIRPLAY_SERVICE, AppleTV, COMPANION_LINK_SERVICE, ConnectionRecovery, type DiscoveryResult, Proto } from '@basmilius/apple-sdk';
import { DiscoverableDevice } from '../base';
import { AirPlayLogic } from '../logic';
import { capabilityToRepeatMode, getAccessoryCredentialsFromDevice } from '../utils';
import type AppleTVDriver from './driver';
import type Homey from 'homey';

const RECONNECT_INTERVAL = 15 * 60 * 1000;
const SLOW_RECOVERY_INTERVAL = 2 * 60 * 1000;
const SLOW_RECOVERY_MAX_ATTEMPTS = 15;

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

export default class AppleTVDevice extends DiscoverableDevice<AppleTVDriver> {
    get airplayLogic(): AirPlayLogic {
        return this.#airplayLogic;
    }

    get discoveryResultAirPlay(): DiscoveryResult {
        return this.discoveryResults[AIRPLAY_SERVICE];
    }

    get discoveryResultCompanionLink(): DiscoveryResult {
        return this.discoveryResults[COMPANION_LINK_SERVICE];
    }

    get sdk(): AppleTV {
        if (!this.#tv) {
            throw new Error('Apple TV SDK device is not initialized.');
        }

        return this.#tv;
    }

    get services(): Record<string, Homey.DiscoveryStrategy> {
        return this.#services;
    }

    #airplayLogic!: AirPlayLogic;
    #airplayRecovery?: ConnectionRecovery;
    #companionLinkFailed = false;
    #companionLinkRecovery?: ConnectionRecovery;
    #companionLinkRetried = false;
    #connectedOnce = false;
    #slowRecoveryAttempt = 0;
    #slowRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    #services!: Record<string, Homey.DiscoveryStrategy>;
    #tv?: AppleTV;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#services = {
            [AIRPLAY_SERVICE]: this.discovery.getStrategy('airplay'),
            [COMPANION_LINK_SERVICE]: this.discovery.getStrategy('companion-link')
        };

        this.#airplayLogic = new AirPlayLogic(this);
        await this.#airplayLogic.initialize();

        await this.syncCapabilities(CAPABILITIES);
        this.#registerCapabilities();
        this.#registerMaintenance();

        await super.onInit();

        // If both services were found, #connect() was already triggered from onServiceFound.
        // If only AirPlay was found (CL discovery failed), connect without CL as fallback.
        if (!this.#connectedOnce && this.discoveryResultAirPlay) {
            this.#connectedOnce = true;
            await this.#connect();
        }

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        this.#stopSlowRecovery();
        this.#airplayRecovery?.dispose();
        this.#companionLinkRecovery?.dispose();
        await this.#airplayLogic.uninitialize();
        this.#tv?.disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        try {
            const credentials = getAccessoryCredentialsFromDevice(this);

            if (!credentials) {
                await this.setUnavailable('Cannot find credentials, please re-pair the device.');
                return;
            }

            if (!this.discoveryResultAirPlay) {
                await this.setUnavailable('Service discovery not complete, waiting for device...');
                return;
            }

            // Create or reconfigure the SDK device.
            if (!this.#tv) {
                this.#tv = new AppleTV({
                    airplay: this.discoveryResultAirPlay,
                    companionLink: this.discoveryResultCompanionLink ?? undefined
                });

                this.#airplayLogic.setDevice(this.#tv);
                this.#wireEvents();
                this.#setupRecovery(credentials);
            } else {
                this.#tv.discoveryResult = this.discoveryResultAirPlay;

                if (this.#tv.companionLink) {
                    this.#tv.companionLink.discoveryResult = this.discoveryResultCompanionLink;
                }
            }

            this.log('Connecting to Apple TV...');
            await this.#tv.connect(credentials);

            // The SDK silently swallows Companion Link connection failures.
            // If AirPlay connected but CL didn't, still mark available and start CL recovery.
            if (this.#tv.airplay.isConnected && !this.#tv.companionLink?.isConnected) {
                this.log('AirPlay connected, but Companion Link failed. Starting recovery...');
                await this.setAvailable();
                this.#companionLinkRecovery?.handleDisconnect(true);
            }
        } catch (err) {
            this.error('Error received', err);
            await this.setUnavailable('Cannot connect to Apple TV.');
        }
    }

    #wireEvents(): void {
        if (!this.#tv) {
            return;
        }

        this.#tv.on('connected', async () => {
            this.#airplayRecovery?.reset();
            this.log('Connected to Apple TV (AirPlay).');

            if (this.#tv!.companionLink?.isConnected) {
                await this.setAvailable();
            }
        });

        this.#tv.on('disconnected', async (unexpected: boolean) => {
            if (!unexpected) {
                return;
            }

            this.log('Disconnected from Apple TV (AirPlay), reconnecting...');
            await this.setUnavailable('Disconnected from Apple TV (AirPlay), reconnecting...');
            this.#airplayRecovery?.handleDisconnect(unexpected);
        });

        this.#tv.on('power', async (state) => {
            this.log('#onPower()', {state});

            const isOn = state === 'awake' || state === 'screensaver';

            try {
                await this.setCapabilityValue('onoff', isOn);
                await this.setCapabilityValue('power', this.homey.__(isOn ? 'capability.power.on' : 'capability.power.off'));
            } catch (err) {
                this.error('Failed to set power state.', err);
            }

            if (isOn) {
                this.#airplayLogic.emitUpdate();
                return;
            }

            await this.#airplayLogic.clearNowPlaying();
        });

        if (this.#tv.companionLink) {
            this.#tv.companionLink.on('connected', async () => {
                this.#companionLinkRecovery?.reset();
                this.#companionLinkRetried = false;
                this.#stopSlowRecovery();
                this.log('Connected to Apple TV (Companion Link).');

                if (this.#tv!.airplay.isConnected) {
                    await this.setAvailable();
                }
            });

            this.#tv.companionLink.on('disconnected', async (unexpected: boolean) => {
                if (!unexpected) {
                    return;
                }

                this.log('Disconnected from Apple TV (Companion Link), reconnecting...');
                await this.setUnavailable('Disconnected from Apple TV (Companion Link), reconnecting...');
                this.#companionLinkRecovery?.handleDisconnect(unexpected);
            });
        }
    }

    #setupRecovery(credentials: NonNullable<ReturnType<typeof getAccessoryCredentialsFromDevice>>): void {
        this.#airplayRecovery?.dispose();
        this.#companionLinkRecovery?.dispose();

        this.#airplayRecovery = new ConnectionRecovery({
            maxAttempts: 3,
            baseDelay: 1000,
            reconnectInterval: RECONNECT_INTERVAL,
            onReconnect: async () => {
                this.#tv!.airplay.disconnectSafely();
                await this.findService(AIRPLAY_SERVICE);
                this.#tv!.discoveryResult = this.discoveryResults[AIRPLAY_SERVICE];
                this.#tv!.airplay.setCredentials(credentials);
                await this.#tv!.airplay.connect();
            }
        });

        this.#airplayRecovery.on('recovering', (attempt) => {
            this.log(`AirPlay recovery attempt ${attempt}...`);
        });

        this.#airplayRecovery.on('failed', () => {
            this.error('AirPlay recovery failed after max attempts.');
        });

        this.#companionLinkRecovery = new ConnectionRecovery({
            maxAttempts: 3,
            baseDelay: 1000,
            reconnectInterval: RECONNECT_INTERVAL,
            onReconnect: async () => {
                await this.#tv!.companionLink!.disconnectSafely();
                await this.findService(COMPANION_LINK_SERVICE);
                this.#tv!.companionLink!.discoveryResult = this.discoveryResultCompanionLink;
                await this.#tv!.companionLink!.setCredentials(credentials);
                await this.#tv!.companionLink!.connect();
            }
        });

        this.#companionLinkRecovery.on('recovering', (attempt) => {
            this.log(`Companion Link recovery attempt ${attempt}...`);
        });

        this.#companionLinkRecovery.on('failed', async () => {
            this.error('Companion Link recovery failed after max attempts.');
            await this.#onCompanionLinkFailed();
        });
    }

    async #startSlowRecovery(): Promise<void> {
        this.log(`Starting slow recovery phase, retrying every ${SLOW_RECOVERY_INTERVAL / 1000}s for up to ${SLOW_RECOVERY_MAX_ATTEMPTS} attempts...`);
        this.#slowRecoveryAttempt = 0;
        this.#scheduleSlowRecoveryAttempt();
        await this.setUnavailable('Device offline, retrying connection...');
    }

    #scheduleSlowRecoveryAttempt(): void {
        this.#slowRecoveryTimer = setTimeout(async () => {
            this.#slowRecoveryTimer = null;
            this.#slowRecoveryAttempt++;

            this.log(`Slow recovery attempt ${this.#slowRecoveryAttempt}/${SLOW_RECOVERY_MAX_ATTEMPTS}...`);

            try {
                await this.findService(COMPANION_LINK_SERVICE);
                this.log(`Re-discovered Companion Link at ${this.discoveryResultCompanionLink.address}:${this.discoveryResultCompanionLink.service.port}, reconnecting...`);
                this.#companionLinkRecovery?.reset();
                this.#tv!.companionLink!.discoveryResult = this.discoveryResultCompanionLink;

                const credentials = getAccessoryCredentialsFromDevice(this);

                if (credentials) {
                    await this.#tv!.companionLink!.setCredentials(credentials);
                    await this.#tv!.companionLink!.connect();
                }
            } catch {
                this.log(`Slow recovery attempt ${this.#slowRecoveryAttempt} failed.`);
            }

            if (this.#slowRecoveryAttempt >= SLOW_RECOVERY_MAX_ATTEMPTS) {
                this.#companionLinkFailed = true;
                this.log('Companion Link failed permanently after extended recovery period. Please restart the app.');
                await this.setUnavailable('Failed to connect to Apple TV using Companion Link. Please restart the app.');
                await this.app.appleTvFlow.triggerCompanionLinkFailed(this);
                return;
            }

            if (!this.#tv?.companionLink?.isConnected) {
                this.#scheduleSlowRecoveryAttempt();
            }
        }, SLOW_RECOVERY_INTERVAL);
    }

    #stopSlowRecovery(): void {
        if (this.#slowRecoveryTimer) {
            clearTimeout(this.#slowRecoveryTimer);
            this.#slowRecoveryTimer = null;
        }
        this.#slowRecoveryAttempt = 0;
    }

    async #onCompanionLinkFailed(): Promise<void> {
        if (this.#companionLinkFailed) {
            return;
        }

        if (this.#slowRecoveryTimer) {
            return;
        }

        if (!this.#companionLinkRetried) {
            this.#companionLinkRetried = true;

            this.log('Companion Link failed, attempting re-discovery before giving up...');
            await this.setUnavailable('Reconnecting to Apple TV...');

            try {
                await this.findService(COMPANION_LINK_SERVICE);
                this.log(`Re-discovered Companion Link at ${this.discoveryResultCompanionLink.address}:${this.discoveryResultCompanionLink.service.port}, reconnecting...`);
                this.#companionLinkRecovery?.reset();
                this.#tv!.companionLink!.discoveryResult = this.discoveryResultCompanionLink;

                const credentials = getAccessoryCredentialsFromDevice(this);

                if (credentials) {
                    await this.#tv!.companionLink!.setCredentials(credentials);
                    await this.#tv!.companionLink!.connect();
                }

                return;
            } catch {
                this.log('Re-discovery of Companion Link service failed.');
            }
        }

        await this.#startSlowRecovery();
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

        this.registerCapabilityListener('volume_up', async () => {
            await this.sdk.volume.up();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.sdk.volume.down();
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.sdk.remote.mute();
        });

        this.registerCapabilityListener('speaker_repeat', async (value: string) => {
            await this.sdk.playback.setRepeatMode(capabilityToRepeatMode[value] ?? Proto.RepeatMode_Enum.Off);
        });

        this.registerCapabilityListener('speaker_shuffle', async (value: boolean) => {
            const mode = value ? Proto.ShuffleMode_Enum.Songs : Proto.ShuffleMode_Enum.Off;
            await this.sdk.playback.setShuffleMode(mode);
        });
    }

    #registerMaintenance(): void {
        this.registerCapabilityListener('button.restart', async () => {
            try {
                this.#stopSlowRecovery();
                this.#companionLinkFailed = false;
                this.#companionLinkRetried = false;
                this.#tv?.disconnect();
                this.#tv = undefined;
                await this.#airplayLogic.clearNowPlaying();
                await this.#connect();
            } catch (err) {
                this.error(err);
            }
        });
    }

    #registerOnOff(): void {
        this.registerCapabilityListener('onoff', async (value: boolean) => {
            if (value) {
                await this.sdk.power?.on();
            } else {
                await this.sdk.power?.off();
            }
        });
    }

    #registerRemote(): void {
        const keys = CAPABILITIES.filter(k => k.startsWith('remote_'));

        this.registerMultipleCapabilityListener(keys, async values => {
            values.remote_up === true && await this.sdk.remote.up();
            values.remote_down === true && await this.sdk.remote.down();
            values.remote_left === true && await this.sdk.remote.left();
            values.remote_right === true && await this.sdk.remote.right();
            values.remote_select === true && await this.sdk.remote.select();
            values.remote_home === true && await this.sdk.remote.home();
            values.remote_back === true && await this.sdk.remote.menu();
            values.remote_playpause === true && await this.sdk.remote.playPause();
        }, 0);
    }

    async onServiceFound(service: string, discoveryResult: DiscoveryResult): Promise<void> {
        await super.onServiceFound(service, discoveryResult);

        if (this.#connectedOnce) {
            return;
        }

        if (!this.discoveryResultAirPlay || !this.discoveryResultCompanionLink) {
            return;
        }

        this.#connectedOnce = true;
        await this.#connect();
    }
}
