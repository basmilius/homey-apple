import { configure, TimingServer } from '@basmilius/apple-sdk';
import { App } from '@basmilius/homey-common';
import AppleTVFlow from './apple-tv/flow';
import HomePodFlow from './homepod-base/flow';

export default class AppleApp extends App<AppleApp> {
    get appleTvFlow(): AppleTVFlow {
        return this.#appleTvFlow;
    }

    get homePodFlow(): HomePodFlow {
        return this.#homePodFlow;
    }

    get timingServer(): TimingServer {
        return this.#timingServer;
    }

    get useTimingServer(): boolean {
        const server = process.env.SERVER;
        return !server || !server.startsWith('ws://host');
    }

    #appleTvFlow!: AppleTVFlow;
    #homePodFlow!: HomePodFlow;
    #timingServer!: TimingServer;

    async onInit(): Promise<void> {
        this.#timingServer = new TimingServer();

        try {
            await this.#timingServer.listen();
        } catch (err) {
            this.error('Failed to start timing server:', err);
        }

        configure({
            logging: ['error', 'warn', 'net'],
            timingServer: this.useTimingServer
                ? this.#timingServer
                : undefined
        });

        this.#appleTvFlow = new AppleTVFlow(this);
        this.#appleTvFlow.register();

        this.#homePodFlow = new HomePodFlow(this);
        this.#homePodFlow.register();

        this.log('Apple TV & HomePod has been initialized');
    }
}
