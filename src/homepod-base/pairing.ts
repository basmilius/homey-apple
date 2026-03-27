import { EventEmitter } from 'node:events';
import { AIRPLAY_SERVICE, HomePod } from '@basmilius/apple-sdk';
import { convertDiscoveryResult, extractMacAddress, waitFor } from '../utils';
import type Homey from 'homey';

export default class HomePodBasePairing extends EventEmitter {
    readonly #knownDevices: Homey.Device[];
    readonly #modelFilter: RegExp;
    readonly #session: Homey.Driver.PairSession;
    readonly #strategy: Homey.DiscoveryStrategy;
    readonly #devices: Homey.DiscoveryResultMDNSSD[];
    readonly #onDiscoveryResult: (result: Homey.DiscoveryResultMDNSSD) => void;
    #device: Homey.DiscoveryResultMDNSSD | undefined;

    constructor(session: Homey.Driver.PairSession, strategy: Homey.DiscoveryStrategy, modelFilter: RegExp, knownDevices: Homey.Device[]) {
        super();

        this.#knownDevices = knownDevices;
        this.#modelFilter = modelFilter;
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
            .filter(device => (device.txt as any).model.match(this.#modelFilter))
            .toSorted((a, b) => a.name.localeCompare(b.name)));

        this.#session.setHandler('list_devices_selection', async (devices: Homey.DiscoveryResultMDNSSD[]) => this.#device = devices.pop());

        this.#session.setHandler('get_device', async () => {
            this.#strategy.off('result', this.#onDiscoveryResult);
            return {
                name: this.#device?.name,
                data: {
                    id: this.#device?.id
                },
                store: {
                    mac: extractMacAddress(this.#device?.txt as Record<string, string>)
                }
            };
        });
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

        const pod = new HomePod({airplay: convertDiscoveryResult(this.#device, AIRPLAY_SERVICE)});

        this.emit('log', `Connecting to ${this.#device.address}:${this.#device.port}...`);

        try {
            await pod.connect();
            this.emit('log', 'Transient pairing successful!');
            pod.disconnect();
        } catch (err) {
            pod.disconnect();
            throw err;
        }

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
