'use strict';

// @ts-ignore
import type { CompanionLink } from '@basmilius/apple-companion-link';
import Homey, { FlowCard } from 'homey';

module.exports = class MyApp extends Homey.App {

    async onInit(): Promise<void> {
        await this.registerActions();

        this.log('Apple has been initialized');
    }

    async registerActions(): Promise<void> {
        await this.registerAppleTVLaunchApp();
        await this.registerAppleTVLaunchUrl();
        await this.registerAppleTVSwitchAccount();
    }

    async registerAppleTVLaunchApp(): Promise<void> {
        const launchApp = this.homey.flow.getActionCard('appletv_launch_app');

        launchApp.registerRunListener(async ({device, app}) => {
            const protocol = device.protocol as CompanionLink;
            await protocol.api.launchApp(app.id);
        });

        launchApp.registerArgumentAutocompleteListener('app', async (query: string, {device}): Promise<FlowCard.ArgumentAutocompleteResults> => {
            const protocol = device.protocol as CompanionLink;
            const launchableApps = await protocol.api.getLaunchableApps();

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

    async registerAppleTVLaunchUrl(): Promise<void> {
        const launchUrl = this.homey.flow.getActionCard('appletv_launch_url');

        launchUrl.registerRunListener(async ({device, url}) => {
            const protocol = device.protocol as CompanionLink;
            await protocol.api.launchUrl(url);
        });
    }

    async registerAppleTVSwitchAccount(): Promise<void> {
        const switchAccount = this.homey.flow.getActionCard('appletv_switch_account');

        switchAccount.registerRunListener(async ({device, account}) => {
            const protocol = device.protocol as CompanionLink;
            await protocol.api.switchUserAccount(account.id);
        });

        switchAccount.registerArgumentAutocompleteListener('account', async (query: string, {device}): Promise<FlowCard.ArgumentAutocompleteResults> => {
            const protocol = device.protocol as CompanionLink;
            const userAccounts = await protocol.api.getUserAccounts();

            return userAccounts
                .filter((app: any) => query.trim().length === 0 || app.name.toLowerCase().includes(query.toLowerCase()))
                .map((app: any) => ({
                    id: app.accountId,
                    name: app.name
                }))
                .sort((a: any, b: any) => a.name.localeCompare(b.name));
        });
    }

};
