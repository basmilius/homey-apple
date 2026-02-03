import { Proto } from '@basmilius/apple-airplay';
import { AIRPLAY_SERVICE, COMPANION_LINK_SERVICE, type Discovery, type DiscoveryResult } from '@basmilius/apple-common';
import { DiscoverableDevice } from '../base';
import { AirPlayConnection, CompanionLinkConnection } from '../connection';
import { AirPlayLogic } from '../logic';
import { waitFor } from '../utils';
import type AppleTVDriver from './driver';

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

    get services(): Record<string, Discovery> {
        return {
            [AIRPLAY_SERVICE]: this.homey.discovery.getStrategy('airplay'),
            [COMPANION_LINK_SERVICE]: this.homey.discovery.getStrategy('companion-link')
        };
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
            this.log('Connecting to Apple TV (AirPlay)...');
            await this.#airplay.createInstance(this.discoveryResultAirPlay);
            await this.#airplay.connect();

            this.log('Connecting to Apple TV (Companion Link)...');
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
            try {
                await this.#disconnect();
                await this.#airplayLogic.clearNowPlaying();
                await this.#connect();
            } catch (err) {
                this.error(err);
            }
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
        this.log('Connected to Apple TV (AirPlay).');
        await this.#onConnected();
    }

    async #onAirPlayDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log('Disconnected from Apple TV (AirPlay), reconnecting...');
        await this.setUnavailable('Disconnected from Apple TV (AirPlay), reconnecting...');
        await waitFor(1000);

        await this.findService(AIRPLAY_SERVICE);
        await this.#airplay.reconnect(this.discoveryResultAirPlay);
    }

    async #onCompanionLinkConnected(): Promise<void> {
        this.log('Connected to Apple TV (Companion Link).');
        await this.#onConnected();
    }

    async #onCompanionLinkDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log('Disconnected from Apple TV (Companion Link), reconnecting...');
        await this.setUnavailable('Disconnected from Apple TV (Companion Link), reconnecting...');
        await waitFor(1000);

        await this.findService(COMPANION_LINK_SERVICE);
        await this.#companionLink.reconnect(this.discoveryResultCompanionLink);
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
