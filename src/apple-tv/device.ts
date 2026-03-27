import { Proto } from '@basmilius/apple-airplay';
import { AIRPLAY_SERVICE, COMPANION_LINK_SERVICE, type DiscoveryResult } from '@basmilius/apple-common';
import { DiscoverableDevice } from '../base';
import { AirPlayConnection, CompanionLinkConnection } from '../connection';
import { AirPlayLogic } from '../logic';
import { getAccessoryCredentialsFromDevice } from '../utils';
import type AppleTVDriver from './driver';
import type Homey from 'homey';

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
    get airplay(): AirPlayConnection {
        return this.#airplay;
    }

    get airplayLogic(): AirPlayLogic {
        return this.#airplayLogic;
    }

    get companionLink(): CompanionLinkConnection {
        return this.#companionLink;
    }

    get discoveryResultAirPlay(): DiscoveryResult {
        return this.discoveryResults[AIRPLAY_SERVICE];
    }

    get discoveryResultCompanionLink(): DiscoveryResult {
        return this.discoveryResults[COMPANION_LINK_SERVICE];
    }

    get services(): Record<string, Homey.DiscoveryStrategy> {
        return this.#services;
    }

    #airplay!: AirPlayConnection;
    #airplayLogic!: AirPlayLogic;
    #companionLink!: CompanionLinkConnection;
    #companionLinkFailed = false;
    #companionLinkRetried = false;
    #connectedOnce = false;
    #slowRecoveryAttempt = 0;
    #slowRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    #services!: Record<string, Homey.DiscoveryStrategy>;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#services = {
            [AIRPLAY_SERVICE]: this.discovery.getStrategy('airplay'),
            [COMPANION_LINK_SERVICE]: this.discovery.getStrategy('companion-link')
        };

        this.#airplayLogic = new AirPlayLogic(this);
        await this.#airplayLogic.initialize();

        this.onAirPlayConnected = this.onAirPlayConnected.bind(this);
        this.onAirPlayDisconnected = this.onAirPlayDisconnected.bind(this);
        this.onCompanionLinkConnected = this.onCompanionLinkConnected.bind(this);
        this.onCompanionLinkDisconnected = this.onCompanionLinkDisconnected.bind(this);
        this.onCompanionLinkFailed = this.onCompanionLinkFailed.bind(this);

        this.#airplay = new AirPlayConnection(this);
        this.#companionLink = new CompanionLinkConnection(this);

        this.#airplay.on('connected', this.onAirPlayConnected);
        this.#airplay.on('disconnected', this.onAirPlayDisconnected);
        this.#companionLink.on('connected', this.onCompanionLinkConnected);
        this.#companionLink.on('disconnected', this.onCompanionLinkDisconnected);
        this.#companionLink.on('failed', this.onCompanionLinkFailed);

        await this.syncCapabilities(CAPABILITIES);
        this.#registerCapabilities();
        this.#registerMaintenance();

        await super.onInit();

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        this.#stopSlowRecovery();
        this.#airplay.removeAllListeners();
        this.#companionLink.removeAllListeners();
        await this.#airplayLogic.uninitialize();
        await this.#disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        try {
            const credentials = getAccessoryCredentialsFromDevice(this);

            if (!credentials) {
                await this.setUnavailable('Cannot find credentials, please re-pair the device.');
                return;
            }

            if (!this.discoveryResultAirPlay || !this.discoveryResultCompanionLink) {
                await this.setUnavailable('Service discovery not complete, waiting for device...');
                return;
            }

            this.log('Connecting to Apple TV (AirPlay)...');
            this.#airplay.createInstance(credentials, this.discoveryResultAirPlay);
            await this.#airplay.connect();

            this.log('Connecting to Apple TV (Companion Link)...');
            this.#companionLink.createInstance(credentials, this.discoveryResultCompanionLink);
            await this.#companionLink.connect();
        } catch (err) {
            this.error('Error received', err);
            await this.setUnavailable('Cannot connect to Apple TV.');
        }
    }

    async #disconnect(): Promise<void> {
        await this.#airplay.disconnect();
        await this.#companionLink.disconnect();
    }

    async #startSlowRecovery(): Promise<void> {
        this.log(`Starting slow recovery phase, retrying every ${SLOW_RECOVERY_INTERVAL / 1000}s for up to ${SLOW_RECOVERY_MAX_ATTEMPTS} attempts...`);
        await this.setUnavailable('Device offline, retrying connection...');
        this.#slowRecoveryAttempt = 0;
        this.#scheduleSlowRecoveryAttempt();
    }

    #scheduleSlowRecoveryAttempt(): void {
        this.#slowRecoveryTimer = setTimeout(async () => {
            this.#slowRecoveryTimer = null;
            this.#slowRecoveryAttempt++;

            this.log(`Slow recovery attempt ${this.#slowRecoveryAttempt}/${SLOW_RECOVERY_MAX_ATTEMPTS}...`);

            try {
                await this.findService(COMPANION_LINK_SERVICE);
                this.log(`Re-discovered Companion Link at ${this.discoveryResultCompanionLink.address}:${this.discoveryResultCompanionLink.service.port}, reconnecting...`);
                this.#companionLink.resetConnectAttempts();
                await this.#companionLink.reconnect(this.discoveryResultCompanionLink);
            } catch {
                this.log(`Slow recovery attempt ${this.#slowRecoveryAttempt} failed.`);
            }

            if (this.#slowRecoveryAttempt >= SLOW_RECOVERY_MAX_ATTEMPTS) {
                this.#companionLinkFailed = true;
                this.log('Companion Link failed permanently after extended recovery period. Please restart the app.');
                await this.#notify('Companion Link failed permanently after extended recovery. Please restart the app.');
                await this.setUnavailable('Failed to connect to Apple TV using Companion Link. Please restart the app.');
                await this.app.appleTvFlow.triggerCompanionLinkFailed(this);
                return;
            }

            if (!this.#companionLink.isConnected) {
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

    #registerCapabilities(): void {
        this.#registerOnOff();
        this.#registerRemote();

        this.registerCapabilityListener('speaker_next', async () => {
            await this.#airplay.protocol.sendCommand(Proto.Command.NextInContext);
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#airplay.protocol.sendCommand(Proto.Command.PreviousInContext);
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#airplay.remote.commandStop();
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.#airplay.remote.commandPlay();
            } else {
                await this.#airplay.remote.commandPause();
            }
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.#airplay.protocol.volume.up();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.#airplay.protocol.volume.down();
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.#airplay.remote.mute();
        });

        this.registerCapabilityListener('speaker_repeat', async (value: string) => {
            const modeMap: Record<string, Proto.RepeatMode_Enum> = {
                none: Proto.RepeatMode_Enum.Off,
                track: Proto.RepeatMode_Enum.One,
                playlist: Proto.RepeatMode_Enum.All,
            };
            await this.#airplay.remote.commandSetRepeatMode(modeMap[value] ?? Proto.RepeatMode_Enum.Off);
        });

        this.registerCapabilityListener('speaker_shuffle', async (value: boolean) => {
            const mode = value ? Proto.ShuffleMode_Enum.Songs : Proto.ShuffleMode_Enum.Off;
            await this.#airplay.remote.commandSetShuffleMode(mode);
        });
    }

    #registerMaintenance(): void {
        this.registerCapabilityListener('button.restart', async () => {
            try {
                this.#stopSlowRecovery();
                this.#companionLinkFailed = false;
                this.#companionLinkRetried = false;
                await this.#disconnect();
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
                await this.#airplay.remote.wake();
            } else {
                await this.#airplay.remote.suspend();
            }
        });
    }

    #registerRemote(): void {
        const keys = CAPABILITIES.filter(k => k.startsWith('remote_'));

        this.registerMultipleCapabilityListener(keys, async values => {
            values.remote_up === true && await this.#airplay.remote.up();
            values.remote_down === true && await this.#airplay.remote.down();
            values.remote_left === true && await this.#airplay.remote.left();
            values.remote_right === true && await this.#airplay.remote.right();
            values.remote_select === true && await this.#airplay.remote.select();
            values.remote_home === true && await this.#airplay.remote.home();
            values.remote_back === true && await this.#airplay.remote.menu();
            values.remote_playpause === true && await this.#airplay.remote.playPause();
        }, 0);
    }

    async #notify(message: string): Promise<void> {
        // await this.homey.notifications.createNotification({
        //     excerpt: `[${this.getName()}] ${message}`
        // });
    }

    async #onConnected(): Promise<void> {
        if (!this.#airplay.isConnected || !this.#companionLink.isConnected) {
            return;
        }

        await this.setAvailable();
    }

    async onAirPlayConnected(): Promise<void> {
        this.log('Connected to Apple TV (AirPlay).');
        await this.#notify('AirPlay connected.');
        await this.#onConnected();
    }

    async onAirPlayDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log('Disconnected from Apple TV (AirPlay), reconnecting...');
        await this.#notify('AirPlay disconnected unexpectedly, reconnecting...');
        await this.setUnavailable('Disconnected from Apple TV (AirPlay), reconnecting...');
    }

    async onCompanionLinkConnected(): Promise<void> {
        this.#companionLinkRetried = false;
        this.#stopSlowRecovery();
        this.log('Connected to Apple TV (Companion Link).');
        await this.#notify('Companion Link connected.');
        await this.#onConnected();
    }

    async onCompanionLinkDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log('Disconnected from Apple TV (Companion Link), reconnecting...');
        await this.#notify('Companion Link disconnected unexpectedly, reconnecting...');
        await this.setUnavailable('Disconnected from Apple TV (Companion Link), reconnecting...');
    }

    async onCompanionLinkFailed(): Promise<void> {
        if (this.#companionLinkFailed) {
            return;
        }

        if (this.#slowRecoveryTimer) {
            return;
        }

        if (!this.#companionLinkRetried) {
            this.#companionLinkRetried = true;

            this.log('Companion Link failed, attempting re-discovery before giving up...');
            await this.#notify('Companion Link failed after 3 attempts, attempting re-discovery...');
            await this.setUnavailable('Reconnecting to Apple TV...');

            try {
                await this.findService(COMPANION_LINK_SERVICE);
                this.log(`Re-discovered Companion Link at ${this.discoveryResultCompanionLink.address}:${this.discoveryResultCompanionLink.service.port}, reconnecting...`);
                await this.#notify(`Re-discovered Companion Link at ${this.discoveryResultCompanionLink.address}:${this.discoveryResultCompanionLink.service.port}, reconnecting...`);
                this.#companionLink.resetConnectAttempts();
                await this.#companionLink.reconnect(this.discoveryResultCompanionLink);
                return;
            } catch {
                this.log('Re-discovery of Companion Link service failed.');
                await this.#notify('Re-discovery of Companion Link service failed.');
            }
        }

        await this.#startSlowRecovery();
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
