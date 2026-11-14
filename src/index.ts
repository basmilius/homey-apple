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

    get useTimingServer(): boolean {
        const server = process.env.SERVER;
        return !server || !server.startsWith('ws://host');
    }

    #appleTvFlow!: AppleTVFlow;
    #homePodFlow!: HomePodFlow;

    async onInit(): Promise<void> {
        this.#appleTvFlow = new AppleTVFlow(this);
        this.#appleTvFlow.register();

        this.#homePodFlow = new HomePodFlow(this);
        this.#homePodFlow.register();

        this.log('Apple TV & HomePod has been initialized');
    }
}
