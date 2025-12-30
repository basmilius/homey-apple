import { EventEmitter } from 'node:events';
import type { AccessoryCredentials } from '@basmilius/apple-common';
import type { AttentionState } from '@basmilius/apple-companion-link';
import { CompanionLinkDevice } from '@basmilius/apple-devices';
import type { Device } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import { waitFor } from '../utils';
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

    readonly #discoveryStrategy: Homey.DiscoveryStrategy;
    readonly #device!: Device<AppleApp, any>;
    #protocol!: CompanionLinkDevice;

    constructor(device: Device<AppleApp, any>, discoveryStrategy: Homey.DiscoveryStrategy) {
        super();
        this.#device = device;
        this.#discoveryStrategy = discoveryStrategy;
    }

    async connect(): Promise<void> {
        const credentials = await this.#credentials();

        await this.#protocol.setCredentials(credentials);
        await this.#protocol.connect();
    }

    async createInstance(): Promise<void> {
        const result = this.#discoveryStrategy.getDiscoveryResult(this.#device.getData().id) as Homey.DiscoveryResultMDNSSD;

        this.#protocol = new CompanionLinkDevice({
            address: result.address,
            service: {
                port: result.port
            }
        });

        this.#protocol.on('connected', () => this.#onConnected());
        this.#protocol.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));
        this.#protocol.on('power', (state: AttentionState) => this.#device.setCapabilityValue('onoff', state === 'awake' || state === 'screensaver'));
    }

    async disconnect(): Promise<void> {
        await this.#protocol.disconnect();
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

        if (!unexpected) {
            return;
        }

        this.#device.log('Disconnected (Companion Link), reconnecting...');
        await this.#device.setUnavailable('Disconnected (Companion Link), reconnecting...');
        await waitFor(1000);

        await this.createInstance();
        await this.connect();
    }
}
