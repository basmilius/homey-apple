import { EventEmitter } from 'node:events';
import { COMPANION_LINK_SERVICE, ConnectionRecovery, type AccessoryCredentials, type DiscoveryResult } from '@basmilius/apple-common';
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
    #protocol!: CompanionLinkDevice;
    #recovery?: ConnectionRecovery;

    constructor(device: AppleTVDevice) {
        super();
        this.#device = device;
    }

    async connect(): Promise<void> {
        await this.#protocol.setCredentials(this.#credentials);
        await this.#protocol.connect();
    }

    createInstance(credentials: AccessoryCredentials, discoveryResult: DiscoveryResult): void {
        this.#credentials = credentials;
        this.#recovery?.dispose();

        this.#protocol = new CompanionLinkDevice(discoveryResult);
        this.#protocol.on('connected', () => this.#onConnected());
        this.#protocol.on('disconnected', (unexpected: boolean) => this.#onDisconnected(unexpected));
        this.#protocol.on('power', (state: AttentionState) => this.#onPower(state));

        this.#recovery = new ConnectionRecovery({
            maxAttempts: 3,
            baseDelay: 1000,
            reconnectInterval: RECONNECT_INTERVAL,
            onReconnect: async () => {
                await this.#protocol.disconnectSafely();
                await this.#device.findService(COMPANION_LINK_SERVICE);
                this.#protocol.discoveryResult = this.#device.discoveryResultCompanionLink;
                await this.connect();
            }
        });

        this.#recovery.on('recovering', (attempt) => {
            this.#device.log(`Companion Link recovery attempt ${attempt}...`);
        });

        this.#recovery.on('failed', () => {
            this.#device.error('Companion Link recovery failed after max attempts.');
            this.emit('failed');
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

    resetConnectAttempts(): void {
        this.#recovery?.reset();
    }

    #onConnected(): void {
        this.#recovery?.reset();
        this.emit('connected');
    }

    #onDisconnected(unexpected: boolean): void {
        this.emit('disconnected', unexpected);
        this.#recovery?.handleDisconnect(unexpected);
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
            await this.#device.airplayLogic.emitUpdate();
            return;
        }

        // note: When the device is turned off, clear the now playing info and now playing app.
        await this.#device.airplayLogic.clearNowPlaying();
    }
}
