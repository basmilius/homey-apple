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

        this.#registerMediaPlaybackWidget();

        this.log('Apple TV & HomePod has been initialized');
    }

    #registerMediaPlaybackWidget(): void {
        const widget = this.homey.dashboards.getWidget('media_playback');

        widget.registerSettingAutocompleteListener('device', async (query: string) => {
            const drivers = await this.getDrivers();
            const results: { id: string; name: string; description: string }[] = [];
            const lang = this.homey.i18n.getLanguage();

            for (const driver of drivers) {
                const devices = await this.getDevices(driver.id);

                if (!devices) {
                    continue;
                }

                for (const device of devices) {
                    results.push({
                        id: device.id,
                        name: device.name,
                        description: driver.manifest.name?.[lang] ?? driver.manifest.name?.en ?? driver.id
                    });
                }
            }

            return results
                .filter(d => query.trim() === '' || d.name.toLowerCase().includes(query.toLowerCase()))
                .sort((a, b) => a.name.localeCompare(b.name));
        });
    }
}
