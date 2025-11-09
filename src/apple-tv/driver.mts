import Homey, { FlowCard } from 'homey';
import AppleTVPairing from './pairing.mjs';

export default class AppleTVDevice extends Homey.Driver {
    async onInit(): Promise<void> {
        await this.#registerActions();
        this.log('AppleTVDriver has been initialized.');
    }

    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        const pairing = new AppleTVPairing(session, this.getDiscoveryStrategy());

        pairing.on('error', err => {
            // todo: Show error screen or something.
            this.error(err);
        });

        pairing.on('log', log => {
            this.log(log);
        });

        await pairing.start();
    }

    async #registerActions(): Promise<void> {
        await this.#registerAppleTVLaunchApp();
        await this.#registerAppleTVLaunchUrl();
        await this.#registerAppleTVSwitchAccount();
    }

    async #registerAppleTVLaunchApp(): Promise<void> {
        const launchApp = this.homey.flow.getActionCard('appletv_launch_app');

        launchApp.registerRunListener(async ({device, app}) => {
            await device.appletv.companionLink.launchApp(app.id);
        });

        launchApp.registerArgumentAutocompleteListener('app', async (query: string, {device}): Promise<FlowCard.ArgumentAutocompleteResults> => {
            const launchableApps = await device.appletv.companionLink.getLaunchableApps();

            return launchableApps
                .filter((app: any) => query.trim().length === 0 || app.name.toLowerCase().includes(query.toLowerCase()))
                .map((app: any) => ({
                    id: app.bundleId,
                    name: app.name,
                    description: app.bundleId
                }))
                .sort((a: any, b: any) => a.name.localeCompare(b.name));
        });
    }

    async #registerAppleTVLaunchUrl(): Promise<void> {
        const launchUrl = this.homey.flow.getActionCard('appletv_launch_url');

        launchUrl.registerRunListener(async ({device, url}) => {
            await device.appletv.companionLink.launchUrl(url);
        });
    }

    async #registerAppleTVSwitchAccount(): Promise<void> {
        const switchAccount = this.homey.flow.getActionCard('appletv_switch_account');

        switchAccount.registerRunListener(async ({device, account}) => {
            await device.appletv.companionLink.switchUserAccount(account.id);
        });

        switchAccount.registerArgumentAutocompleteListener('account', async (query: string, {device}): Promise<FlowCard.ArgumentAutocompleteResults> => {
            const userAccounts = await device.appletv.companionLink.getUserAccounts();

            return userAccounts
                .filter((app: any) => query.trim().length === 0 || app.name.toLowerCase().includes(query.toLowerCase()))
                .map((app: any) => ({
                    id: app.accountId,
                    name: app.name
                }))
                .sort((a: any, b: any) => a.name.localeCompare(b.name));
        });
    }
}
