import { EventEmitter } from 'node:events';
import type { AccessoryCredentials, DiscoveryResult } from '@basmilius/apple-common';
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
    #isReconnecting = false;
    #protocol!: AirPlayDevice;
    #reconnectInterval?: NodeJS.Timeout;

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
            this.#startReconnectInterval();
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
        this.#stopReconnectInterval();
        await this.#protocol?.disconnect();
    }

    async reconnect(discoveryResult: DiscoveryResult): Promise<void> {
        if (discoveryResult) {
            this.#protocol.discoveryResult = discoveryResult;
        }

        await this.connect();
    }

    #startReconnectInterval(): void {
        this.#stopReconnectInterval();

        this.#reconnectInterval = setInterval(async () => {
            if (this.#isReconnecting) {
                return;
            }

            this.#isReconnecting = true;
            this.#device.log('Scheduled AirPlay reconnection...');

            try {
                await this.#protocol.disconnect();
                await this.#device.findServices();
                await this.connect();
            } catch (err) {
                this.#device.error('Failed scheduled AirPlay reconnection:', err);
            } finally {
                this.#isReconnecting = false;
            }
        }, RECONNECT_INTERVAL);
    }

    #stopReconnectInterval(): void {
        if (this.#reconnectInterval) {
            clearInterval(this.#reconnectInterval);
            this.#reconnectInterval = undefined;
        }
    }

    #onConnected(): void {
        this.emit('connected');
    }

    #onDisconnected(unexpected: boolean): void {
        this.#stopReconnectInterval();
        this.emit('disconnected', unexpected);
    }
}
