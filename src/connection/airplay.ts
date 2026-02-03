import { EventEmitter } from 'node:events';
import type { AccessoryCredentials, DiscoveryResult } from '@basmilius/apple-common';
import { AirPlayDevice } from '@basmilius/apple-devices';
import type { AppleTVDevice, HomePodBaseDevice } from '../types';

type EventMap = {
    connected: [];
    disconnected: [boolean];
};

export default class extends EventEmitter<EventMap> {
    get isConnected(): boolean {
        return this.#protocol?.isConnected ?? false;
    }

    get protocol(): AirPlayDevice {
        return this.#protocol;
    }

    get remote(): AirPlayDevice['remote'] {
        return this.#protocol.remote;
    }

    get state(): AirPlayDevice['state'] {
        return this.#protocol.state;
    }

    readonly #device!: AppleTVDevice | HomePodBaseDevice<any>;
    #protocol!: AirPlayDevice;

    constructor(device: AppleTVDevice | HomePodBaseDevice<any>) {
        super();
        this.#device = device;
    }

    async connect(): Promise<void> {
        const credentials = await this.#credentials();

        if (credentials) {
            await this.#protocol.setCredentials(credentials);
        }

        if (this.#device.app.useTimingServer) {
            this.#device.log('Using timing server');
            this.#protocol.timingServer = this.#device.app.timingServer;
        }

        try {
            await this.#protocol.connect();
        } catch (err) {
            this.#device.error('Failed to connect to AirPlay device:', err);
            await this.#device.setUnavailable(`Failed to connect to AirPlay device. Please file a diagnostics report. ${(err as Error).message}`);
        }
    }

    async createInstance(discoveryResult: DiscoveryResult): Promise<void> {
        this.#protocol = new AirPlayDevice(discoveryResult);
        this.#protocol.on('connected', () => this.#onConnected());
        this.#protocol.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));

        await this.#device.airplayLogic.setProtocol(this.#protocol);
    }

    async disconnect(): Promise<void> {
        await this.#protocol.disconnect();
    }

    async reconnect(discoveryResult: DiscoveryResult): Promise<void> {
        if (discoveryResult) {
            this.#protocol.discoveryResult = discoveryResult;
        }

        await this.connect();
    }

    async #credentials(): Promise<AccessoryCredentials | null> {
        const credentials = this.#device.getStoreValue('credentials');

        if (!credentials) {
            return null;
        }

        return {
            accessoryIdentifier: credentials.accessoryIdentifier,
            accessoryLongTermPublicKey: Buffer.from(credentials.accessoryLongTermPublicKey, 'hex'),
            pairingId: Buffer.from(credentials.pairingId, 'hex'),
            publicKey: Buffer.from(credentials.publicKey, 'hex'),
            secretKey: Buffer.from(credentials.secretKey, 'hex')
        };
    }

    async #onConnected(): Promise<void> {
        this.emit('connected');
    }

    async #onDisconnected(unexpected: boolean): Promise<void> {
        this.emit('disconnected', unexpected);
    }
}
