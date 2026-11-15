import { EventEmitter } from 'node:events';
import { type ClientIdentity, HomePod } from '@corewire/devices';
import { extractMacAddress, toDeviceTarget, waitFor, withTimeout } from '../utils';
import type Homey from 'homey';

// Leaves room for the quick retries after 1, 2 and 4 seconds, so a HomePod that answers late still pairs.
const CONNECT_TIMEOUT = 20_000;
const DISCOVERY_TRIES = 10;

export default class HomePodBasePairing extends EventEmitter {
    readonly #identity: ClientIdentity;
    readonly #knownDevices: Homey.Device[];
    readonly #loggedSkips = new Set<string>();
    readonly #modelFilter: RegExp;
    readonly #session: Homey.Driver.PairSession;
    readonly #strategy: Homey.DiscoveryStrategy;
    readonly #devices: Homey.DiscoveryResultMDNSSD[];
    readonly #onDiscoveryResult: (result: Homey.DiscoveryResultMDNSSD) => void;
    readonly #useTimingServer: boolean;
    #device: Homey.DiscoveryResultMDNSSD | undefined;
    #error: string | undefined;

    constructor(session: Homey.Driver.PairSession, strategy: Homey.DiscoveryStrategy, modelFilter: RegExp, knownDevices: Homey.Device[], useTimingServer: boolean, identity: ClientIdentity) {
        super();

        this.#identity = identity;
        this.#knownDevices = knownDevices;
        this.#modelFilter = modelFilter;
        this.#session = session;
        this.#strategy = strategy;
        this.#useTimingServer = useTimingServer;

        this.#devices = Object.values(this.#strategy.getDiscoveryResults()) as Homey.DiscoveryResultMDNSSD[];
        this.#onDiscoveryResult = result => this.#addDevice(result);
        this.#strategy.on('result', this.#onDiscoveryResult);
    }

    async start(): Promise<void> {
        this.#session.setHandler('showView', async view => await this.onShowView(view));

        this.#session.setHandler('list_devices', async () => {
            const devices = this.#selectableDevices();
            this.emit('log', `Discovery: ${this.#devices.length} result(s) on the network, ${devices.length} selectable for ${this.#modelFilter}.`);

            return devices;
        });

        this.#session.setHandler('list_devices_selection', async (devices: Homey.DiscoveryResultMDNSSD[]) => this.#device = devices.pop());

        this.#session.setHandler('get_pair_error', async () => this.#error ?? null);

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
            await this.#fail(err);
        }
    }

    async onShowViewAuthenticate(): Promise<void> {
        if (!this.#device) {
            await this.#session.showView('list_devices');
            this.emit('error', 'No device selected.');
            return;
        }

        const pod = new HomePod(toDeviceTarget(this.#device), {
            identity: this.#identity,
            log: entry => this.emit('log', entry.message),
            timing: this.#useTimingServer ? undefined : false
        });

        this.emit('log', `Connecting to ${this.#device.address}:${this.#device.port}...`);

        try {
            await withTimeout(pod.connect(), CONNECT_TIMEOUT, `${this.#device.name} did not respond within ${CONNECT_TIMEOUT / 1000} seconds.`);
            this.emit('log', 'Transient pairing successful!');
        } finally {
            await pod.disconnect();
        }

        await this.#session.showView('add_my_device');
    }

    async onShowViewDiscover(): Promise<void> {
        let tries = DISCOVERY_TRIES;

        while (tries-- > 0) {
            if (this.#selectableDevices().length > 0 || tries === 0) {
                await this.#session.showView('list_devices');
                return;
            }

            await waitFor(1000);
        }
    }

    async #fail(err: unknown): Promise<void> {
        this.#error = err instanceof Error ? err.message : String(err);
        this.emit('error', err);

        try {
            await this.#session.showView('connection_error');
        } catch (viewError) {
            this.emit('error', viewError);
        }
    }

    #addDevice(device: Homey.DiscoveryResultMDNSSD): void {
        if (this.#devices.some(known => known.id === device.id)) {
            return;
        }

        this.#devices.push(device);
    }

    #matchesModel(device: Homey.DiscoveryResultMDNSSD): boolean {
        const model = (device.txt as any)?.model;

        if (!model) {
            if (!this.#loggedSkips.has(device.id)) {
                this.#loggedSkips.add(device.id);
                this.emit('log', `Skipping incomplete discovery result for '${device.name ?? device.id}': missing txt.model`, device);
            }

            return false;
        }

        if (!this.#modelFilter.test(model)) {
            if (!this.#loggedSkips.has(device.id)) {
                this.#loggedSkips.add(device.id);
                this.emit('log', `Skipping '${device.name ?? device.id}': model '${model}' does not match ${this.#modelFilter}.`);
            }

            return false;
        }

        return true;
    }

    #selectableDevices(): Homey.DiscoveryResultMDNSSD[] {
        return this.#devices
            .filter(device => !this.#knownDevices.some(knownDevice => knownDevice.getData().id === device.id))
            .filter(device => this.#matchesModel(device))
            .toSorted((a, b) => a.name.localeCompare(b.name));
    }
}
