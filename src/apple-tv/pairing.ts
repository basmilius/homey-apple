import { EventEmitter } from 'node:events';
import { AIRPLAY_SERVICE, AppleTV, type PairingSession } from '@basmilius/apple-sdk';
import { convertDiscoveryResult, extractMacAddress, waitFor } from '../utils';
import type Homey from 'homey';

type Device = Homey.DiscoveryResultMDNSSD & {
    store?: Record<string, unknown>;
};

export default class AppleTVPairing extends EventEmitter {
    readonly #knownDevices: Homey.Device[];
    readonly #session: Homey.Driver.PairSession;
    readonly #strategy: Homey.DiscoveryStrategy;
    readonly #devices: Homey.DiscoveryResultMDNSSD[];
    readonly #onDiscoveryResult: (result: Homey.DiscoveryResultMDNSSD) => void;
    #device: Device | undefined;
    #pairingSession?: PairingSession;

    constructor(session: Homey.Driver.PairSession, strategy: Homey.DiscoveryStrategy, knownDevices: Homey.Device[]) {
        super();

        this.#knownDevices = knownDevices;
        this.#session = session;
        this.#strategy = strategy;

        this.#devices = Object.values(this.#strategy.getDiscoveryResults()) as Homey.DiscoveryResultMDNSSD[];
        this.#onDiscoveryResult = result => this.#devices.push(result);
        this.#strategy.on('result', this.#onDiscoveryResult);
    }

    async start(): Promise<void> {
        this.#session.setHandler('showView', async view => await this.onShowView(view));

        this.#session.setHandler('list_devices', async () => this.#devices
            .filter(device => !this.#knownDevices.some(knownDevice => knownDevice.getData().id === device.id))
            .filter(device => (device.txt as any).model.match(/AppleTV\d+,\d+/))
            .toSorted((a, b) => a.name.localeCompare(b.name)));

        this.#session.setHandler('list_devices_selection', async (devices: Homey.DiscoveryResultMDNSSD[]) => this.#device = devices.pop());

        this.#session.setHandler('pincode', async (code: Buffer) => await this.onPincode(code));

        this.#session.setHandler('get_device', async () => {
            this.#strategy.off('result', this.#onDiscoveryResult);
            return {
                name: this.#device?.name,
                data: {
                    id: this.#device?.id
                },
                store: {
                    id: this.#device?.id,
                    credentials: this.#device?.store?.credentials,
                    mac: extractMacAddress(this.#device?.txt as Record<string, string>)
                }
            };
        });
    }

    async onPincode(code: Buffer): Promise<Device | undefined> {
        if (!this.#device || !this.#pairingSession) {
            this.emit('error', 'No device selected.');
            return;
        }

        const pin = code.join('');
        this.emit('log', `Pairing to ${this.#device.name} with PIN ${pin}`);

        await this.#pairingSession.pin(pin);
        const credentials = await this.#pairingSession.end();

        this.#device.store ??= {};
        this.#device.store.credentials = {
            accessoryIdentifier: credentials.accessoryIdentifier,
            accessoryLongTermPublicKey: credentials.accessoryLongTermPublicKey.toString('hex'),
            pairingId: credentials.pairingId.toString('hex'),
            publicKey: credentials.publicKey.toString('hex'),
            secretKey: credentials.secretKey.toString('hex')
        };

        this.#session.showView('add_device')
            .catch(e => this.emit('log', e));

        return this.#device;
    }

    async onShowView(view: string): Promise<void> {
        try {
            switch (view) {
                case 'authenticate':
                    return await this.onShowViewAuthenticate();

                case 'discover':
                    return await this.onShowViewDiscover();
            }
        } catch (err) {
            this.emit('error', err);
        }
    }

    async onShowViewAuthenticate(): Promise<void> {
        if (!this.#device) {
            await this.#session.showView('list_devices');
            this.emit('error', 'No device selected.');
            return;
        }

        const tv = new AppleTV({airplay: convertDiscoveryResult(this.#device, AIRPLAY_SERVICE)});
        this.#pairingSession = tv.createPairingSession();

        this.emit('log', `Connecting to ${this.#device.address}:${this.#device.port}...`);

        try {
            await this.#pairingSession.start();
        } catch (err) {
            this.#pairingSession.abort();
            this.#pairingSession = undefined;
            throw err;
        }
    }

    async onShowViewDiscover(): Promise<void> {
        let tries = 5;

        while (tries-- > 0) {
            if (this.#devices.length > 0 || tries === 0) {
                await this.#session.showView('list_devices');
                return;
            }

            await waitFor(1000);
        }
    }
}
