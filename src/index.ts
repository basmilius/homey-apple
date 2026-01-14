import { reporter, TimingServer } from '@basmilius/apple-common';
import { App } from '@basmilius/homey-common';
import Discovery from './discovery';

reporter.enable('error');
reporter.enable('warn');
// reporter.enable('net');
// reporter.all();

export default class AppleApp extends App<AppleApp> {
    get discovery(): Discovery {
        return this.#discovery;
    }

    get timingServer(): TimingServer {
        return this.#timingServer;
    }

    get useTimingServer(): boolean {
        return !('SERVER' in process.env) || !process.env.SERVER!.startsWith('ws://host');
    }

    #discovery!: Discovery;
    #timingServer!: TimingServer;

    async onInit(): Promise<void> {
        this.#discovery = new Discovery(this);

        this.#timingServer = new TimingServer();
        this.#timingServer.listen();

        this.log('Apple has been initialized');
    }
}
