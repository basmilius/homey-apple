import { EventEmitter } from 'node:events';
import { Proto } from '@basmilius/apple-airplay';
import type { AccessoryCredentials } from '@basmilius/apple-common';
import { AirPlayDevice } from '@basmilius/apple-devices';
import type { Device } from '@basmilius/homey-common';
import { AirPlayLogic } from '../logic';
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

    get remote(): AirPlayDevice['remote'] {
        return this.#protocol.remote;
    }

    readonly #discoveryStrategy: Homey.DiscoveryStrategy;
    readonly #device!: Device<AppleApp, any>;
    #logic!: AirPlayLogic;
    #protocol!: AirPlayDevice;

    constructor(device: Device<AppleApp, any>, discoveryStrategy: Homey.DiscoveryStrategy) {
        super();
        this.#device = device;
        this.#discoveryStrategy = discoveryStrategy;
    }

    async connect(): Promise<void> {
        const credentials = await this.#credentials();

        if (credentials) {
            await this.#protocol.setCredentials(credentials);
        }

        await this.#protocol.connect();
        await this.#logic.finalize();
    }

    async createInstance(): Promise<void> {
        const result = this.#discoveryStrategy.getDiscoveryResult(this.#device.getStoreValue('id')) as Homey.DiscoveryResultMDNSSD;

        this.#protocol = new AirPlayDevice({
            address: result.address,
            service: {
                port: result.port
            },
            packet: {
                additionals: [{
                    rdata: result.txt
                }]
            }
        });

        this.#protocol.on('connected', () => this.#onConnected());
        this.#protocol.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));

        this.#logic = new AirPlayLogic(this.#device, this.#protocol);
        await this.#logic.initialize();
    }

    async disconnect(): Promise<void> {
        await this.#logic.uninitialize();
        await this.#protocol.disconnect();
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

        if (!unexpected) {
            return;
        }

        await this.#logic.uninitialize();

        this.#device.log('Disconnected (AirPlay), reconnecting...');
        await this.#device.setUnavailable('Disconnected (AirPlay), reconnecting...');
        await waitFor(1000);

        await this.createInstance();
        await this.connect();
    }

    async sendCommand(command: Proto.Command, options?: Proto.CommandOptions): Promise<void> {
        await this.#protocol.sendCommand(command, options);
    }

    async setVolume(volume: number): Promise<void> {
        await this.#protocol.setVolume(volume);
    }
}
