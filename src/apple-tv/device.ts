import { Proto } from '@basmilius/apple-airplay';
import { DeviceMDNSSD } from '@basmilius/homey-common';
import { AirPlayConnection, CompanionLinkConnection } from '../connection';
import { AirPlayLogic } from '../logic';
import type { AppleApp } from '../types';
import { waitFor } from '../utils';
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
    'onoff',
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

export default class AppleTVDevice extends DeviceMDNSSD<AppleApp, AppleTVDriver> {
    get airplay(): AirPlayConnection {
        return this.#airplay;
    }

    get airplayLogic(): AirPlayLogic {
        return this.#airplayLogic;
    }

    get companionLink(): CompanionLinkConnection {
        return this.#companionLink;
    }

    get discoveryId(): string {
        return this.getData().id;
    }

    get discoveryResultAirPlay(): Homey.DiscoveryResultMDNSSD {
        return this.discoveryResults['appletv-airplay'];
    }

    get discoveryResultCompanionLink(): Homey.DiscoveryResultMDNSSD {
        return this.discoveryResults['appletv-companion-link'];
    }

    get discoveryStrategies(): string[] {
        return ['appletv-airplay', 'appletv-companion-link'];
    }

    #airplay!: AirPlayConnection;
    #airplayLogic!: AirPlayLogic;
    #companionLink!: CompanionLinkConnection;
    #connectedOnce = false;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#airplayLogic = new AirPlayLogic(this);
        await this.#airplayLogic.initialize();

        this.#airplay = new AirPlayConnection(this);
        this.#companionLink = new CompanionLinkConnection(this);

        this.#airplay.on('connected', () => this.#onAirPlayConnected());
        this.#airplay.on('disconnected', (unexpected) => this.#onAirPlayDisconnected(unexpected));
        this.#companionLink.on('connected', () => this.#onCompanionLinkConnected());
        this.#companionLink.on('disconnected', (unexpected) => this.#onCompanionLinkDisconnected(unexpected));

        await this.removeOldCapabilities(CAPABILITIES);
        await this.#registerCapabilities();
        await this.#registerMaintenance();

        await super.onInit();

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        await this.#airplayLogic.uninitialize();
        await this.#disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        try {
            await this.#airplay.createInstance(this.discoveryResultAirPlay);
            await this.#airplay.connect();

            await this.#companionLink.createInstance(this.discoveryResultCompanionLink);
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

    async #registerCapabilities(): Promise<void> {
        await this.#registerOnOff();
        await this.#registerRemote();

        this.registerCapabilityListener('speaker_next', async () => {
            await this.#airplay.protocol.sendCommand(Proto.Command.NextInContext);
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#airplay.protocol.sendCommand(Proto.Command.PreviousInContext);
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#airplay.protocol.sendCommand(Proto.Command.Stop);
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.#airplay.protocol.sendCommand(Proto.Command.Play);
            } else {
                await this.#airplay.protocol.sendCommand(Proto.Command.Pause);
            }
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.#airplay.remote.volumeUp();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.#airplay.remote.volumeDown();
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.#airplay.remote.mute();
        });
    }

    async #registerMaintenance(): Promise<void> {
        this.registerCapabilityListener('button.restart', async () => {
            await this.#disconnect();
            await this.#airplayLogic.clearNowPlaying();
            await this.#connect();
        });
    }

    async #registerOnOff(): Promise<void> {
        this.registerCapabilityListener('onoff', async (value: boolean) => {
            if (value) {
                await this.#airplay.remote.wake();
            } else {
                await this.#airplay.remote.suspend();
            }
        });
    }

    async #registerRemote(): Promise<void> {
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

    async #onConnected(): Promise<void> {
        if (!this.#airplay.isConnected || !this.#companionLink.isConnected) {
            return;
        }

        await this.setAvailable();
    }

    async #onAirPlayConnected(): Promise<void> {
        await this.#onConnected();
    }

    async #onAirPlayDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log('Disconnected from Apple TV (AirPlay), reconnecting...');
        await this.setUnavailable('Disconnected from Apple TV (AirPlay), reconnecting...');
        await waitFor(1000);

        await this.#airplay.reconnect(this.discoveryResultAirPlay);
    }

    async #onCompanionLinkConnected(): Promise<void> {
        await this.#onConnected();
    }

    async #onCompanionLinkDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log('Disconnected from Apple TV (Companion Link), reconnecting...');
        await this.setUnavailable('Disconnected from Apple TV (Companion Link), reconnecting...');
        await waitFor(1000);

        await this.#companionLink.reconnect(this.discoveryResultCompanionLink);
    }

    async onDeviceDiscoveryResult(): Promise<void> {
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
