import { EventEmitter } from 'node:events';
import { AirPlay } from '@basmilius/apple-airplay';
import { waitFor } from '@basmilius/utils';
import type { DiscoveryResultMDNSSD, DiscoveryStrategy } from 'homey';
import Homey from 'homey';

type Device = DiscoveryResultMDNSSD & {
    store?: Record<string, unknown>;
};

export default class AppleTVPairing extends EventEmitter {
    readonly #session: Homey.Driver.PairSession;
    readonly #strategy: DiscoveryStrategy;
    readonly #devices: DiscoveryResultMDNSSD[];
    #device: Device | undefined;
    #protocol: AirPlay;
    #m1: any;
    #m2: any;
    #m3: any;
    #m4: any;
    #m5: any;

    constructor(session: Homey.Driver.PairSession, strategy: DiscoveryStrategy) {
        super();

        this.#session = session;
        this.#strategy = strategy;

        this.#devices = Object.values(this.#strategy.getDiscoveryResults()) as DiscoveryResultMDNSSD[];
        this.#strategy.on('result', result => this.#devices.push(result));
    }

    async start(): Promise<void> {
        this.#session.setHandler('showView', async view => await this.onShowView(view));
        this.#session.setHandler('list_devices', async () => this.#devices);
        this.#session.setHandler('list_devices_selection', async (devices: DiscoveryResultMDNSSD[]) => this.#device = devices.pop());
        this.#session.setHandler('pincode', async (code: Buffer) => await this.onPincode(code));
        this.#session.setHandler('get_device', async () => ({
            name: this.#device?.name,
            data: {
                id: this.#device?.id
            },
            store: {
                id: this.#device?.id,
                credentials: this.#device?.store?.credentials
            }
        }));
    }

    async onPincode(code: Buffer): Promise<Device | undefined> {
        const pin = code.join('');
        this.emit('log', `Pairing to ${this.#device?.name} with PIN ${pin}`);

        this.#m2 = await this.#protocol.pairing.internal.m2(this.#m1, pin);
        this.#m3 = await this.#protocol.pairing.internal.m3(this.#m2);
        this.#m4 = await this.#protocol.pairing.internal.m4(this.#m3);
        this.#m5 = await this.#protocol.pairing.internal.m5(this.#m4);

        const credentials = await this.#protocol.pairing.internal.m6(this.#m4, this.#m5);

        this.#device!.store ??= {};
        this.#device!.store!.credentials = {
            accessoryIdentifier: credentials.accessoryIdentifier,
            accessoryLongTermPublicKey: credentials.accessoryLongTermPublicKey.toString('hex'),
            pairingId: credentials.pairingId.toString('hex'),
            publicKey: credentials.publicKey.toString('hex'),
            secretKey: credentials.secretKey.toString('hex')
        };

        await this.#session.showView('add_device');
        await this.#protocol.disconnect();

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

        this.#protocol = new AirPlay({
            address: this.#device.address,
            service: {
                port: this.#device.port
            }
        });

        this.emit('log', `Connecting to ${this.#device.address}:${this.#device.port}...`);

        await this.#protocol.connect();
        await this.#protocol.pairing.start();
        await this.#protocol.pairing.pinStart();

        this.#m1 = await this.#protocol.pairing.internal.m1();
    }

    async onShowViewDiscover(): Promise<void> {
        let tries = 5;

        while (tries-- > 0) {
            if (this.#devices.length > 0) {
                await this.#session.showView('list_devices');
                return;
            }

            await waitFor(1000);
        }
    }
}
