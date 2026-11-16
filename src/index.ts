import type { ClientIdentity } from '@apple-protocols/devices';
import { App } from '@basmilius/homey-common';
import AppleTVFlow from './apple-tv/flow';
import HomePodFlow from './homepod-base/flow';
import { withTimeout } from './utils';

const DEFAULT_CLIENT_NAME = 'Apple Protocols';
const HOMEY_NAME_TIMEOUT = 5000;

export default class AppleApp extends App<AppleApp> {
    get appleTvFlow(): AppleTVFlow {
        return this.#appleTvFlow;
    }

    /**
     * How this Homey presents itself to Apple devices: the name an Apple TV lists after pairing,
     * and the name in the AirPlay setup, URL playback, now playing and Companion Link handshakes.
     */
    get clientIdentity(): ClientIdentity {
        return {name: this.#clientName};
    }

    get homePodFlow(): HomePodFlow {
        return this.#homePodFlow;
    }

    get useTimingServer(): boolean {
        const server = process.env.SERVER;

        return !server || !server.startsWith('ws://host');
    }

    #appleTvFlow!: AppleTVFlow;
    #clientName = DEFAULT_CLIENT_NAME;
    #homePodFlow!: HomePodFlow;

    async onInit(): Promise<void> {
        this.#clientName = await this.#readHomeyName() ?? DEFAULT_CLIENT_NAME;
        this.log(`Presenting as ${this.#clientName} to Apple devices.`);

        this.#appleTvFlow = new AppleTVFlow(this);
        this.#appleTvFlow.register();

        this.#homePodFlow = new HomePodFlow(this);
        this.#homePodFlow.register();

        this.log('Apple TV & HomePod has been initialized');
    }

    /**
     * The name of this Homey from the Web API, since the Apps SDK has no call for it. When the
     * request fails or times out the default name stays.
     */
    async #readHomeyName(): Promise<string | null> {
        try {
            const name = await withTimeout(this.homey.api.get('/manager/system/name'), HOMEY_NAME_TIMEOUT, 'Reading the Homey name timed out.');

            return typeof name === 'string' && name.trim() ? name.trim() : null;
        } catch (err) {
            this.log('Cannot read the name of this Homey:', err instanceof Error ? err.message : err);

            return null;
        }
    }
}
