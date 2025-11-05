import { EventEmitter } from 'node:events';
import { AirPlay } from '@basmilius/apple-airplay';
import { waitFor } from '@basmilius/utils';
import type { DiscoveryResultMDNSSD, DiscoveryStrategy } from 'homey';
import Homey from 'homey';

export default class HomePodMiniPairing extends EventEmitter {
    readonly #session: Homey.Driver.PairSession;
    readonly #strategy: DiscoveryStrategy;
    readonly #devices: DiscoveryResultMDNSSD[];
    #device: DiscoveryResultMDNSSD | undefined;
    #protocol: AirPlay;

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

        this.emit('log', `Pairing done! Keys: ${keys.accessoryToControllerKey.toString('hex')} ${keys.controllerToAccessoryKey.toString('hex')}`);

        await this.#protocol.rtsp.enableEncryption(
            keys.accessoryToControllerKey,
            keys.controllerToAccessoryKey
        );

        const info = await this.#protocol.rtsp.get('/info');

        this.emit('log', `Received info response with status ${info.status}.`);

        if (info.status !== 200) {
            // todo: Translate
            throw new Error('Kan geen verbinding maken met de HomePod Mini vanwege een fout in de verificatie. Probeer het opnieuw.');
        }

        this.emit('log', 'Linked to HomePod Mini.');

        await this.#session.showView('add_my_device');
        await this.#protocol.disconnect();
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
