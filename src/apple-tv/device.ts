import type { AccessoryCredentials } from '@basmilius/apple-common';
import { AppleTV } from '@basmilius/apple-devices';
import { Device } from '@basmilius/homey-common';
import Homey from 'homey';
import { AirPlayLogic } from '../logic';
import type { AppleApp } from '../types';
import { waitFor } from '../utils';

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
    'remote_siri'
];

export default class AppleTVDevice extends Device<AppleApp> {
    get appletv(): AppleTV {
        return this.#appletv;
    }

    #airplay!: AirPlayLogic;
    #appletv!: AppleTV;

    async onInit(): Promise<void> {
        this.#appletv = await this.#createAppleTVInstance();
        this.#appletv.on('connected', () => this.#onConnected());
        this.#appletv.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));

        this.#airplay = new AirPlayLogic(this, this.#appletv.airplay);
        await this.#airplay.initialize();

        this.#appletv.companionLink.on('power', (on: boolean) => this.setCapabilityValue('onoff', on));

        await this.removeOldCapabilities(CAPABILITIES);
        await this.#registerCapabilities();
        await this.#connect();
        await this.#airplay.finalize();

        this.log('Initialized.');
    }

    async onUninit(): Promise<void> {
        await this.#airplay.uninitialize();
        await this.#appletv?.disconnect();

        this.log('Uninitialized.');
    }

    async #connect(): Promise<void> {
        try {
            await this.#appletv.connect(await this.#credentials());
        } catch (err) {
            this.error('Error received', err);
            await this.setUnavailable('Cannot connect to Apple TV.');
        }
    }

    async #createAppleTVInstance(): Promise<AppleTV> {
        const [airplay, companionLink] = await this.#discover();

        return new AppleTV(
            {
                address: airplay.address,
                service: {
                    port: airplay.port
                },
                packet: {
                    additionals: [{
                        rdata: airplay.txt
                    }]
                }
            },
            {
                address: companionLink.address,
                service: {
                    port: companionLink.port
                }
            }
        );
    }

    async #credentials(): Promise<AccessoryCredentials> {
        const credentials = this.getStore().credentials;

        return {
            accessoryIdentifier: credentials.accessoryIdentifier,
            accessoryLongTermPublicKey: Buffer.from(credentials.accessoryLongTermPublicKey, 'hex'),
            pairingId: Buffer.from(credentials.pairingId, 'hex'),
            publicKey: Buffer.from(credentials.publicKey, 'hex'),
            secretKey: Buffer.from(credentials.secretKey, 'hex')
        };
    }

    async #discover(): Promise<[Homey.DiscoveryResultMDNSSD, Homey.DiscoveryResultMDNSSD]> {
        const airplayStrategy = this.homey.discovery.getStrategy('appletv-airplay');
        const companionLinkStrategy = this.homey.discovery.getStrategy('appletv-companion-link');

        const airplayResult = airplayStrategy.getDiscoveryResult(this.getStore().id);
        const companionLinkResult = companionLinkStrategy.getDiscoveryResult(this.getStore().id);

        return [
            airplayResult as Homey.DiscoveryResultMDNSSD,
            companionLinkResult as Homey.DiscoveryResultMDNSSD
        ];
    }

    async #registerCapabilities(): Promise<void> {
        await this.#registerOnOff();
        await this.#registerRemote();

        this.registerCapabilityListener('speaker_next', async () => {
            await this.#appletv.next();
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#appletv.previous();
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#appletv.stop();
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.#appletv.play();
            } else {
                await this.#appletv.pause();
            }
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.#appletv.volumeUp();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.#appletv.volumeDown();
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.#appletv.volumeMute();
        });
    }

    async #registerOnOff(): Promise<void> {
        this.registerCapabilityListener('onoff', async (value: boolean) => {
            if (value) {
                await this.#appletv.turnOn();
            } else {
                await this.#appletv.turnOff();
            }
        });
    }

    async #registerRemote(): Promise<void> {
        const keys = CAPABILITIES.filter(k => k.startsWith('remote_'));

        this.registerMultipleCapabilityListener(keys, async values => {
            values.remote_up === true && await this.#appletv.companionLink.pressButton('Up');
            values.remote_down === true && await this.#appletv.companionLink.pressButton('Down');
            values.remote_left === true && await this.#appletv.companionLink.pressButton('Left');
            values.remote_right === true && await this.#appletv.companionLink.pressButton('Right');
            values.remote_select === true && await this.#appletv.companionLink.pressButton('Select');
            values.remote_home === true && await this.#appletv.companionLink.pressButton('Home');
            values.remote_back === true && await this.#appletv.companionLink.pressButton('Menu');
            values.remote_playpause === true && await this.#appletv.companionLink.pressButton('PlayPause');
            values.remote_siri === true && await this.#appletv.companionLink.pressButton('Siri', 'Hold', 1000);
        }, 0);
    }

    async #onConnected(): Promise<void> {
        const state = await this.#appletv.companionLink.getAttentionState();
        await this.setAvailable();
        await this.setCapabilityValue('onoff', state === 'awake' || state === 'screensaver');
    }

    async #onDisconnected(unexpected: boolean): Promise<void> {
        if (!unexpected) {
            return;
        }

        this.log(`Disconnected, reconnecting in a moment...`);

        await this.setUnavailable('Disconnected from Apple TV.');
        await waitFor(1000);

        const [, companionLink] = await this.#discover();
        await this.#appletv.companionLink.setDiscoveryResult({
            address: companionLink.address,
            service: {
                port: companionLink.port
            }
        });

        await this.#connect();
    }
}
