import { EventEmitter } from 'node:events';
import type { AccessoryCredentials } from '@basmilius/apple-common';
import type { AttentionState } from '@basmilius/apple-companion-link';
import { CompanionLinkDevice } from '@basmilius/apple-devices';
import type { AppleTVDevice, StrategyKey } from '../types';
import { waitFor } from '../utils';

type EventMap = {
    connected: [];
    disconnected: [boolean];
};

export default class extends EventEmitter<EventMap> {
    get discoveryId(): string {
        return this.#device.getData().id;
    }

    get isConnected(): boolean {
        return this.#protocol?.isConnected ?? false;
    }

    get protocol(): CompanionLinkDevice {
        return this.#protocol;
    }

    readonly #discoveryStrategy: StrategyKey;
    readonly #device: AppleTVDevice;
    #protocol!: CompanionLinkDevice;

    constructor(device: AppleTVDevice, discoveryStrategy: StrategyKey) {
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
        const result = this.#device.app.discovery.get(this.#discoveryStrategy, this.discoveryId);

        if (!result) {
            this.#device.log('No discovery result found for Companion Link device');
            await this.#device.setUnavailable(`Failed to connect to Companion Link device. Please file a diagnostics report. No discovery result found for Companion Link device with ID ${this.discoveryId}.`);
            return;
        }

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

        const result = this.#device.app.discovery.get(this.#discoveryStrategy, this.discoveryId);

        if (!result) {
            this.#device.log('No discovery result found for Companion Link device');
            await this.#device.setUnavailable(`Failed to reconnect to Companion Link device. Please file a diagnostics report. No discovery result found for Companion Link device with ID ${this.discoveryId}.`);
            return;
        }

        this.#protocol.discoveryResult = {
            address: result.address,
            service: {
                port: result.port
            }
        };

        await this.connect();
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
