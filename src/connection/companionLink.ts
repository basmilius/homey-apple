import { EventEmitter } from 'node:events';
import type { AccessoryCredentials } from '@basmilius/apple-common';
import { CompanionLinkDevice } from '@basmilius/apple-devices';
import type { AppleTVDevice } from '../types';
import type Homey from 'homey';

export type AttentionState =
    | 'unknown'
    | 'asleep'
    | 'screensaver'
    | 'awake'
    | 'idle';

type EventMap = {
    connected: [];
    disconnected: [boolean];
};

const RECONNECT_INTERVAL = 5 * 60 * 1000;

export default class extends EventEmitter<EventMap> {
    get isConnected(): boolean {
        return this.#protocol?.isConnected ?? false;
    }

    get protocol(): CompanionLinkDevice {
        return this.#protocol;
    }

    readonly #device: AppleTVDevice;
    #protocol!: CompanionLinkDevice;
    #reconnectInterval?: NodeJS.Timeout;

    constructor(device: AppleTVDevice) {
        super();
        this.#device = device;
    }

    async connect(): Promise<void> {
        const credentials = await this.#credentials();

        await this.#protocol.setCredentials(credentials);

        try {
            await this.#protocol.connect();
            this.#startReconnectInterval();
        } catch (err) {
            this.#device.error('Failed to connect to Companion Link device:', err);
            await this.#device.setUnavailable(`Failed to connect to Companion Link device. Please file a diagnostics report. ${(err as Error).message}`);
        }
    }

    async createInstance(result: Homey.DiscoveryResultMDNSSD): Promise<void> {
        this.#protocol = new CompanionLinkDevice(result.id, {
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
        this.#stopReconnectInterval();
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

    #startReconnectInterval(): void {
        this.#stopReconnectInterval();

        this.#reconnectInterval = setInterval(async () => {
            this.#device.log('Scheduled reconnection interval reached, restarting Companion Link connection...');

            try {
                await this.#protocol.disconnect();
                await this.connect();
            } catch (err) {
                this.#device.error('Failed to restart Companion Link connection:', err);
            }
        }, RECONNECT_INTERVAL);
    }

    #stopReconnectInterval(): void {
        if (this.#reconnectInterval) {
            clearInterval(this.#reconnectInterval);
            this.#reconnectInterval = undefined;
        }
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
        await this.#onPower(state);

        this.emit('connected');
    }

    async #onDisconnected(unexpected: boolean): Promise<void> {
        this.emit('disconnected', unexpected);
    }

    async #onPower(state: AttentionState): Promise<void> {
        this.#device.log('#onPower()', {state});

        const isOn = state === 'awake' || state === 'screensaver';

        try {
            await this.#device.setCapabilityValue('onoff', isOn);
            await this.#device.setCapabilityValue('power', this.#device.homey.__(isOn ? 'capability.power.on' : 'capability.power.off'));
        } catch (err) {
            this.#device.error('Failed to set power state.', err);
        }

        if (isOn) {
            return;
        }

        // note: When the device is turned off, clear the now playing info and now playing app.
        await this.#device.airplayLogic.clearNowPlaying();
    }
}
