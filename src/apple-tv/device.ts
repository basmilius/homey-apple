import { Proto } from '@basmilius/apple-airplay';
import { Device } from '@basmilius/homey-common';
import { AirPlayConnection, CompanionLinkConnection } from '../connection';
import type { AppleApp } from '../types';
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
    'now_playing_app'
];

export default class AppleTVDevice extends Device<AppleApp, AppleTVDriver> {
    #airplay!: AirPlayConnection;
    #companionLink!: CompanionLinkConnection;

    async onInit(): Promise<void> {
        await this.setUnavailable('Connecting...');

        this.#airplay = new AirPlayConnection(this, this.homey.discovery.getStrategy('appletv-airplay'));
        this.#companionLink = new CompanionLinkConnection(this, this.homey.discovery.getStrategy('appletv-companion-link'));

        this.#airplay.on('connected', () => this.#onConnected());
        this.#companionLink.on('connected', () => this.#onConnected());

        await this.removeOldCapabilities(CAPABILITIES);
        await this.#registerCapabilities();
        await this.#connect();

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        await this.#airplay?.disconnect();
        await this.#companionLink?.disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        try {
            await this.#airplay.createInstance();
            await this.#airplay.connect();

            await this.#companionLink.createInstance();
            await this.#companionLink.connect();
        } catch (err) {
            this.error('Error received', err);
            await this.setUnavailable('Cannot connect to Apple TV.');
        }
    }

    async #registerCapabilities(): Promise<void> {
        await this.#registerOnOff();
        await this.#registerRemote();

        this.registerCapabilityListener('speaker_next', async () => {
            await this.#airplay.sendCommand(Proto.Command.NextInContext);
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#airplay.sendCommand(Proto.Command.PreviousInContext);
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#airplay.sendCommand(Proto.Command.Stop);
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.#airplay.sendCommand(Proto.Command.Play);
            } else {
                await this.#airplay.sendCommand(Proto.Command.Pause);
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
}
