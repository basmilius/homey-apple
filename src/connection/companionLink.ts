import { EventEmitter } from 'node:events';
import { type AccessoryCredentials, COMPANION_LINK_SERVICE, type DiscoveryResult } from '@basmilius/apple-common';
import { CompanionLinkDevice } from '@basmilius/apple-devices';
import type { AppleTVDevice } from '../types';

export type AttentionState =
    | 'unknown'
    | 'asleep'
    | 'screensaver'
    | 'awake'
    | 'idle';

type EventMap = {
    connected: [];
    disconnected: [boolean];
    failed: [];
};

const MAX_CONNECT_ATTEMPTS = 3;
const RECONNECT_INTERVAL = 15 * 60 * 1000;

export default class CompanionLinkConnection extends EventEmitter<EventMap> {
    get isConnected(): boolean {
        return this.#protocol?.isConnected ?? false;
    }

    get protocol(): CompanionLinkDevice {
        return this.#protocol;
    }

    readonly #device: AppleTVDevice;
    #credentials!: AccessoryCredentials;
    #isReconnecting = false;
    #protocol!: CompanionLinkDevice;
    #connectAttempts = 0;
    #reconnectInterval?: NodeJS.Timeout;

    constructor(device: AppleTVDevice) {
        super();
        this.#device = device;
    }

    async connect(): Promise<void> {
        await this.#protocol.setCredentials(this.#credentials);

        try {
            await this.#protocol.connect();
            this.#startReconnectInterval();
        } catch (err) {
            this.#device.error('Failed to connect to Companion Link device:', err);
            await this.#device.setUnavailable(`Failed to connect to Companion Link device. Please file a diagnostics report. ${(err as Error).message}`);
        }
    }

    createInstance(credentials: AccessoryCredentials, discoveryResult: DiscoveryResult): void {
        this.#credentials = credentials;

        this.#protocol = new CompanionLinkDevice(discoveryResult);
        this.#protocol.on('connected', () => this.#onConnected());
        this.#protocol.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));
        this.#protocol.on('power', (state: AttentionState) => this.#onPower(state));
    }

    async disconnect(): Promise<void> {
        this.#stopReconnectInterval();
        await this.#protocol.disconnect();
    }

    async reconnect(discoveryResult?: DiscoveryResult): Promise<void> {
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
            this.#device.log('Scheduled Companion Link reconnection...');

            try {
                await this.#protocol.disconnect();
                await this.#device.findService(COMPANION_LINK_SERVICE);
                await this.reconnect(this.#device.discoveryResultCompanionLink);
            } catch (err) {
                this.#device.error('Failed scheduled Companion Link reconnection:', err);
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

    resetConnectAttempts(): void {
        this.#connectAttempts = 0;
    }

    #onConnected(): void {
        this.#connectAttempts = 0;
        this.emit('connected');
    }

    #onDisconnected(unexpected: boolean): void {
        this.#connectAttempts++;

        if (this.#connectAttempts >= MAX_CONNECT_ATTEMPTS) {
            this.emit('failed');
        } else {
            this.emit('disconnected', unexpected);
        }
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
