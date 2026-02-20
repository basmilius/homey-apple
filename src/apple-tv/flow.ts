import { Shortcuts } from '@basmilius/homey-common';
import type { AppleApp, AppleTVDevice } from '../types';
import type Homey from 'homey';

export default class AppleTVFlow extends Shortcuts<AppleApp> {
    register(): void {
        this.#registerLaunchApp();
        this.#registerLaunchUrl();
        this.#registerRemote();
        this.#registerSwitchAccount();
    }

    async triggerCompanionLinkFailed(device: AppleTVDevice): Promise<void> {
        const triggerCard = this.flow.getDeviceTriggerCard('appletv_companion_link_failed');
        await triggerCard.trigger(device);
    }

    async triggerArtworkUrlUpdated(device: AppleTVDevice, localUrl: string, cloudUrl: string): Promise<void> {
        const triggerCard = this.flow.getDeviceTriggerCard('appletv_artwork_url_updated');

        await triggerCard.trigger(device, {
            localUrl,
            cloudUrl
        });
    }

    async triggerNowPlayingAppChanges(device: AppleTVDevice, bundleIdentifier: string, displayName: string): Promise<void> {
        const triggerCard = this.flow.getDeviceTriggerCard('appletv_now_playing_app_changes');

        await triggerCard.trigger(device, {
            bundleIdentifier,
            displayName
        });
    }

    #registerLaunchApp(): void {
        const launchApp = this.flow.getActionCard('appletv_launch_app');

        type AutocompleteArguments = {
            readonly device: AppleTVDevice;
        };

        type RunArguments = {
            readonly app: AppleApp;
            readonly device: AppleTVDevice;
        };

        launchApp.registerRunListener(async ({app, device}: RunArguments) => {
            await device.companionLink.protocol.launchApp(app.id);
        });

        launchApp.registerArgumentAutocompleteListener('app', async (query: string, {device}: AutocompleteArguments): Promise<Homey.FlowCard.ArgumentAutocompleteResults> => {
            const launchableApps = await device.companionLink.protocol.getLaunchableApps();

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

    #registerLaunchUrl(): void {
        const launchUrl = this.flow.getActionCard('appletv_launch_url');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly url: string;
        }

        launchUrl.registerRunListener(async ({device, url}: RunArguments) => {
            await device.companionLink.protocol.launchUrl(url);
        });
    }

    #registerRemote(): void {
        const remote = this.flow.getActionCard('appletv_remote');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly command: string;
        }

        remote.registerRunListener(async ({device, command}: RunArguments) => {
            switch (command) {
                case 'up':
                    await device.airplay.remote.up();
                    break;

                case 'down':
                    await device.airplay.remote.down();
                    break;

                case 'left':
                    await device.airplay.remote.left();
                    break;

                case 'right':
                    await device.airplay.remote.right();
                    break;

                case 'select':
                    await device.airplay.remote.select();
                    break;

                case 'menu':
                    await device.airplay.remote.menu();
                    break;

                case 'home':
                    await device.airplay.remote.home();
                    break;

                case 'play':
                    await device.airplay.remote.play();
                    break;

                case 'pause':
                    await device.airplay.remote.pause();
                    break;

                case 'playPause':
                    await device.airplay.remote.playPause();
                    break;

                case 'next':
                    await device.airplay.remote.next();
                    break;

                case 'previous':
                    await device.airplay.remote.previous();
                    break;

                case 'volumeUp':
                    await device.airplay.remote.volumeUp();
                    break;

                case 'volumeDown':
                    await device.airplay.remote.volumeDown();
                    break;

                case 'mute':
                    await device.airplay.remote.mute();
                    break;

                case 'wake':
                    await device.airplay.remote.wake();
                    break;

                case 'suspend':
                    await device.airplay.remote.suspend();
                    break;
            }
        });
    }

    #registerSwitchAccount(): void {
        const switchAccount = this.flow.getActionCard('appletv_switch_account');

        type AutocompleteArguments = {
            readonly device: AppleTVDevice;
        };

        type RunArguments = {
            readonly account: {
                readonly id: string;
            };
            readonly device: AppleTVDevice;
        };

        switchAccount.registerRunListener(async ({device, account}: RunArguments) => {
            await device.companionLink.protocol.switchUserAccount(account.id);
        });

        switchAccount.registerArgumentAutocompleteListener('account', async (query: string, {device}: AutocompleteArguments): Promise<Homey.FlowCard.ArgumentAutocompleteResults> => {
            const userAccounts = await device.companionLink.protocol.getUserAccounts();

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
