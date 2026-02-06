import { Driver } from '@basmilius/homey-common';
import Homey from 'homey';
import type { AppleApp } from '../types';
import type AppleTVDevice from './device';
import AppleTVPairing from './pairing';

export default class AppleTVDriver extends Driver<AppleApp> {
    async onInit(): Promise<void> {
        await this.#registerActions();
        this.log('Apple TV Driver has been initialized.');
    }

    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        const pairing = new AppleTVPairing(session, this.discovery.getStrategy('airplay'), this.getDevices());

        pairing.on('error', err => {
            // todo: Show error screen or something.
            this.error(err);
        });

        pairing.on('log', log => {
            this.log(log);
        });

        await pairing.start();
    }

    async triggerNowPlayingAppChanges(device: AppleTVDevice, bundleIdentifier: string, displayName: string): Promise<void> {
        const triggerCard = this.homey.flow.getDeviceTriggerCard('appletv_now_playing_app_changes');

        await triggerCard.trigger(device, {
            bundleIdentifier,
            displayName
        });
    }

    async #registerActions(): Promise<void> {
        await this.#registerLaunchApp();
        await this.#registerLaunchUrl();
        await this.#registerRemote();
        await this.#registerSwitchAccount();
    }

    async #registerLaunchApp(): Promise<void> {
        const launchApp = this.homey.flow.getActionCard('appletv_launch_app');

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

    async #registerLaunchUrl(): Promise<void> {
        const launchUrl = this.homey.flow.getActionCard('appletv_launch_url');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly url: string;
        }

        launchUrl.registerRunListener(async ({device, url}: RunArguments) => {
            await device.companionLink.protocol.launchUrl(url);
        });
    }

    async #registerRemote(): Promise<void> {
        const remote = this.homey.flow.getActionCard('appletv_remote');

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

    async #registerSwitchAccount(): Promise<void> {
        const switchAccount = this.homey.flow.getActionCard('appletv_switch_account');

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
