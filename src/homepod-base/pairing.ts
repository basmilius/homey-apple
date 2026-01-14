import { EventEmitter } from 'node:events';
import { AirPlay } from '@basmilius/apple-airplay';
import { waitFor } from '../utils';
import type Homey from 'homey';

export default class HomePodBasePairing extends EventEmitter {
    readonly #knownDevices: Homey.Device[];
    readonly #session: Homey.Driver.PairSession;
    readonly #strategy: Homey.DiscoveryStrategy;
    readonly #devices: Homey.DiscoveryResultMDNSSD[];
    #device: Homey.DiscoveryResultMDNSSD | undefined;
    #protocol: AirPlay;

    constructor(session: Homey.Driver.PairSession, strategy: Homey.DiscoveryStrategy, knownDevices: Homey.Device[]) {
        super();

        this.#knownDevices = knownDevices;
        this.#session = session;
        this.#strategy = strategy;

        this.#devices = Object.values(this.#strategy.getDiscoveryResults()) as Homey.DiscoveryResultMDNSSD[];
        this.#strategy.on('result', result => this.#devices.push(result));
    }

    async start(): Promise<void> {
        this.#session.setHandler('showView', async view => await this.onShowView(view));

        this.#session.setHandler('list_devices', async () => this.#devices
            .filter(device => !this.#knownDevices.some(knownDevice => knownDevice.getData().id === device.id))
            .toSorted((a, b) => a.name.localeCompare(b.name)));

        this.#session.setHandler('list_devices_selection', async (devices: Homey.DiscoveryResultMDNSSD[]) => this.#device = devices.pop());

        this.#session.setHandler('get_device', async () => ({
            name: this.#device?.name,
            data: {
                id: this.#device?.id
            },
            store: {
                id: this.#device?.id
            }
        }));
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
        const keys = await this.#protocol.pairing.transient();

        this.emit('log', `Pairing successful! Keys: ${keys.accessoryToControllerKey.toString('hex')} ${keys.controllerToAccessoryKey.toString('hex')}`);

        await this.#protocol.disconnect();
        await this.#session.showView('add_my_device');
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
