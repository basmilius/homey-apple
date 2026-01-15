import { EventEmitter } from 'node:events';
import type { AccessoryCredentials } from '@basmilius/apple-common';
import type { AttentionState } from '@basmilius/apple-companion-link';
import { CompanionLinkDevice } from '@basmilius/apple-devices';
import type { AppleTVDevice } from '../types';
import type Homey from 'homey';

type EventMap = {
    connected: [];
    disconnected: [boolean];
};

export default class extends EventEmitter<EventMap> {
    get isConnected(): boolean {
        return this.#protocol?.isConnected ?? false;
    }

    get protocol(): CompanionLinkDevice {
        return this.#protocol;
    }

    readonly #device: AppleTVDevice;
    #protocol!: CompanionLinkDevice;

    constructor(device: AppleTVDevice) {
        super();
        this.#device = device;
    }

    async connect(): Promise<void> {
        const credentials = await this.#credentials();

        await this.#protocol.setCredentials(credentials);

        try {
            await this.#protocol.connect();
        } catch (err) {
            this.#device.error('Failed to connect to Companion Link device:', err);
            await this.#device.setUnavailable(`Failed to connect to Companion Link device. Please file a diagnostics report. ${(err as Error).message}`);
        }
    }

    async createInstance(result: Homey.DiscoveryResultMDNSSD): Promise<void> {
        this.#protocol = new CompanionLinkDevice({
            address: result.address,
            service: {
                port: result.port
            }
        });

        this.#protocol.on('connected', () => this.#onConnected());
        this.#protocol.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));
        this.#protocol.on('power', (state: AttentionState) => this.#onPower(state));
    }

    async disconnect(): Promise<void> {
        await this.#protocol.disconnect();
    }

    async reconnect(result?: Homey.DiscoveryResultMDNSSD): Promise<void> {
        if (result) {
            this.#protocol.discoveryResult = {
                address: result.address,
                service: {
                    port: result.port
                }
            };
        }

        await this.connect();
    }

    async #credentials(): Promise<AccessoryCredentials> {
        const credentials = this.#device.getStoreValue('credentials');

        return {
            accessoryIdentifier: credentials.accessoryIdentifier,
            accessoryLongTermPublicKey: Buffer.from(credentials.accessoryLongTermPublicKey, 'hex'),
            pairingId: Buffer.from(credentials.pairingId, 'hex'),
            publicKey: Buffer.from(credentials.publicKey, 'hex'),
            secretKey: Buffer.from(credentials.secretKey, 'hex')
        };
    }

    async #onConnected(): Promise<void> {
        const state = await this.#protocol.getAttentionState();
        await this.#device.setCapabilityValue('onoff', state === 'awake' || state === 'screensaver');

        this.emit('connected');
    }

    async #onDisconnected(unexpected: boolean): Promise<void> {
        this.emit('disconnected', unexpected);
    }

    async #onPower(state: AttentionState): Promise<void> {
        const isOn = state === 'awake' || state === 'screensaver';
        await this.#device.setCapabilityValue('onoff', isOn);

        if (isOn) {
            return;
        }

        // note: When the device is turned off, clear the now playing info.
        await this.#device.airplayLogic.clearNowPlaying();
    }
}
