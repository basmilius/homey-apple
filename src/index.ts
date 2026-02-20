import { reporter, TimingServer } from '@basmilius/apple-common';
import { App } from '@basmilius/homey-common';
import AppleTVFlow from './apple-tv/flow';
import HomePodFlow from './homepod-base/flow';

reporter.enable('error');
reporter.enable('warn');
reporter.enable('net');
// reporter.all();

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
        return !('SERVER' in process.env) || !process.env.SERVER!.startsWith('ws://host');
    }

    #appleTvFlow!: AppleTVFlow;
    #homePodFlow!: HomePodFlow;
    #timingServer!: TimingServer;

    async onInit(): Promise<void> {
        this.#timingServer = new TimingServer();
        this.#timingServer.listen();

        this.#appleTvFlow = new AppleTVFlow(this);
        this.#appleTvFlow.register();

        this.#homePodFlow = new HomePodFlow(this);
        this.#homePodFlow.register();

        this.log('Apple TV & HomePod has been initialized');
    }
}
