import { EventEmitter } from 'node:events';
import type { AccessoryCredentials, DiscoveryResult } from '@basmilius/apple-common';
import { AirPlayDevice } from '@basmilius/apple-devices';
import type { AppleTVDevice, HomePodBaseDevice } from '../types';

type EventMap = {
    connected: [];
    disconnected: [boolean];
};

export default class AirPlayConnection extends EventEmitter<EventMap> {
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
    #credentials: AccessoryCredentials | null = null;
    #protocol!: AirPlayDevice;

    constructor(device: AppleTVDevice | HomePodBaseDevice<any>) {
        super();

        this.#device = device;
    }

    async connect(): Promise<void> {
        if (this.#credentials) {
            await this.#protocol.setCredentials(this.#credentials);
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

    createInstance(credentials: AccessoryCredentials | null, discoveryResult: DiscoveryResult): void {
        this.#credentials = credentials;

        this.#protocol = new AirPlayDevice(discoveryResult);
        this.#protocol.on('connected', this.#onConnected.bind(this));
        this.#protocol.on('disconnected', this.#onDisconnected.bind(this));

        this.#device.airplayLogic.setProtocol(this.#protocol);
    }

    async disconnect(): Promise<void> {
        await this.#protocol?.disconnect();
    }

    async reconnect(discoveryResult: DiscoveryResult): Promise<void> {
        if (discoveryResult) {
            this.#protocol.discoveryResult = discoveryResult;
        }

        await this.connect();
    }

    #onConnected(): void {
        this.emit('connected');
    }

    #onDisconnected(unexpected: boolean): void {
        this.emit('disconnected', unexpected);
    }
}
