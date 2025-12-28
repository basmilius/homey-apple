import { reporter, TimingServer } from '@basmilius/apple-common';
import { App } from '@basmilius/homey-common';

reporter.enable('error');
reporter.enable('warn');
// reporter.all();

export default class AppleApp extends App<AppleApp> {
    get timingServer(): TimingServer {
        return this.#timingServer;
    }

    get useTimingServer(): boolean {
        return !('SERVER' in process.env) || !process.env.SERVER!.startsWith('ws://host')
    }

    #timingServer: TimingServer;

    async onInit(): Promise<void> {
        this.#timingServer = new TimingServer();
        this.#timingServer.listen();

        this.log('Apple has been initialized');
    }
}
