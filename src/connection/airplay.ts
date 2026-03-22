import { EventEmitter } from 'node:events';
import { AIRPLAY_SERVICE, ConnectionRecovery, type AccessoryCredentials, type DiscoveryResult } from '@basmilius/apple-common';
import { AirPlayDevice } from '@basmilius/apple-devices';
import type { AppleTVDevice, HomePodBaseDevice } from '../types';

type EventMap = {
    connected: [];
    disconnected: [boolean];
};

const RECONNECT_INTERVAL = 15 * 60 * 1000;

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
    #recovery?: ConnectionRecovery;

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

        await this.#protocol.connect();
    }

    createInstance(credentials: AccessoryCredentials | null, discoveryResult: DiscoveryResult): void {
        this.#credentials = credentials;
        this.#recovery?.dispose();

        this.#protocol = new AirPlayDevice(discoveryResult);
        this.#protocol.on('connected', this.#onConnected.bind(this));
        this.#protocol.on('disconnected', this.#onDisconnected.bind(this));

        this.#device.airplayLogic.setProtocol(this.#protocol);

        this.#recovery = new ConnectionRecovery({
            maxAttempts: 3,
            baseDelay: 1000,
            reconnectInterval: RECONNECT_INTERVAL,
            onReconnect: async () => {
                this.#protocol.disconnectSafely();
                await this.#device.findService(AIRPLAY_SERVICE);
                this.#protocol.discoveryResult = this.#device.discoveryResults[AIRPLAY_SERVICE];
                await this.connect();
            }
        });

        this.#recovery.on('recovering', (attempt) => {
            this.#device.log(`AirPlay recovery attempt ${attempt}...`);
        });

        this.#recovery.on('failed', () => {
            this.#device.error('AirPlay recovery failed after max attempts.');
        });
    }

    async disconnect(): Promise<void> {
        this.#recovery?.dispose();
        await this.#protocol?.disconnect();
    }

    async reconnect(discoveryResult?: DiscoveryResult): Promise<void> {
        if (discoveryResult) {
            this.#protocol.discoveryResult = discoveryResult;
        }

        await this.connect();
    }

    #onConnected(): void {
        this.#recovery?.reset();
        this.emit('connected');
    }

    #onDisconnected(unexpected: boolean): void {
        this.emit('disconnected', unexpected);
        this.#recovery?.handleDisconnect(unexpected);
    }
}
