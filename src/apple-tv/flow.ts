import { Proto } from '@basmilius/apple-airplay';
import { Shortcuts } from '@basmilius/homey-common';
import type { AppleApp, AppleTVDevice } from '../types';
import { repeatModeToProto } from '../utils';
import type Homey from 'homey';

export default class AppleTVFlow extends Shortcuts<AppleApp> {
    register(): void {
        this.#registerLaunchApp();
        this.#registerLaunchUrl();
        this.#registerRemote();
        this.#registerSetPosition();
        this.#registerSetRepeat();
        this.#registerSetShuffle();
        this.#registerSkipBackward();
        this.#registerSkipForward();
        this.#registerSwitchAccount();
    }

    async triggerCompanionLinkFailed(device: AppleTVDevice): Promise<void> {
        try {
            const triggerCard = this.flow.getDeviceTriggerCard('appletv_companion_link_failed');
            await triggerCard.trigger(device);
        } catch (err) {
            this.log(device.name, 'Failed to trigger companion link failed card.', err);
        }
    }

    async triggerArtworkUrlUpdated(device: AppleTVDevice, localUrl: string, cloudUrl: string): Promise<void> {
        try {
            const triggerCard = this.flow.getDeviceTriggerCard('appletv_artwork_url_updated');

            await triggerCard.trigger(device, {
                localUrl,
                cloudUrl
            });
        } catch (err) {
            this.log(device.name, 'Failed to trigger artwork url updated card.', err);
        }
    }

    async triggerNowPlayingAppChanges(device: AppleTVDevice, bundleIdentifier: string, displayName: string): Promise<void> {
        try {
            const triggerCard = this.flow.getDeviceTriggerCard('appletv_now_playing_app_changes');

            await triggerCard.trigger(device, {
                bundleIdentifier,
                displayName
            });
        } catch (err) {
            this.log(device.name, 'Failed to trigger now playing app changes card.', err);
        }
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
            const launchableApps: { name: string; bundleId: string }[] = await device.companionLink.protocol.getLaunchableApps();
            const lowerQuery = query.trim().toLowerCase();

            return launchableApps
                .filter(app => lowerQuery.length === 0 || app.name.toLowerCase().includes(lowerQuery))
                .map(app => ({
                    id: app.bundleId,
                    name: app.name,
                    description: app.bundleId
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
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
            const commands: Record<string, () => Promise<void>> = {
                up: () => device.airplay.remote.up(),
                down: () => device.airplay.remote.down(),
                left: () => device.airplay.remote.left(),
                right: () => device.airplay.remote.right(),
                select: () => device.airplay.remote.select(),
                menu: () => device.airplay.remote.menu(),
                home: () => device.airplay.remote.home(),
                play: () => device.airplay.remote.play(),
                pause: () => device.airplay.remote.pause(),
                playPause: () => device.airplay.remote.playPause(),
                next: () => device.airplay.remote.next(),
                previous: () => device.airplay.remote.previous(),
                volumeUp: () => device.airplay.protocol.volume.up(),
                volumeDown: () => device.airplay.protocol.volume.down(),
                mute: () => device.airplay.remote.mute(),
                stop: () => device.airplay.remote.stop(),
                screensaver: () => device.companionLink.protocol.pressButton('Screensaver'),
                topMenu: () => device.airplay.remote.topMenu(),
                homeHold: () => device.companionLink.protocol.pressButton('Home', 'Hold'),
                doubleTapSelect: () => device.companionLink.protocol.pressButton('Select', 'DoubleTap'),
                channelUp: () => device.airplay.remote.channelUp(),
                channelDown: () => device.airplay.remote.channelDown(),
                siri: () => device.companionLink.protocol.pressButton('Siri'),
                wake: () => device.airplay.remote.wake(),
                suspend: () => device.airplay.remote.suspend()
            };

            const fn = commands[command];

            if (!fn) {
                throw new Error(`Unknown remote command: ${command}`);
            }

            await fn();
        });
    }

    #registerSetPosition(): void {
        const card = this.flow.getActionCard('appletv_set_position');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly position: number;
        };

        card.registerRunListener(async ({device, position}: RunArguments) => {
            await device.airplay.remote.commandSeekToPosition(Math.floor(position));
        });
    }

    #registerSetRepeat(): void {
        const card = this.flow.getActionCard('appletv_set_repeat');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly mode: string;
        };

        card.registerRunListener(async ({device, mode}: RunArguments) => {
            await device.airplay.remote.commandSetRepeatMode(repeatModeToProto[mode] ?? Proto.RepeatMode_Enum.Off);
        });
    }

    #registerSetShuffle(): void {
        const card = this.flow.getActionCard('appletv_set_shuffle');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly shuffle: string;
        };

        card.registerRunListener(async ({device, shuffle}: RunArguments) => {
            const mode = shuffle === 'true'
                ? Proto.ShuffleMode_Enum.Songs
                : Proto.ShuffleMode_Enum.Off;
            await device.airplay.remote.commandSetShuffleMode(mode);
        });
    }

    #registerSkipBackward(): void {
        const card = this.flow.getActionCard('appletv_skip_backward');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.airplay.remote.commandSkipBackward(Math.floor(seconds));
        });
    }

    #registerSkipForward(): void {
        const card = this.flow.getActionCard('appletv_skip_forward');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.airplay.remote.commandSkipForward(Math.floor(seconds));
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
            const userAccounts: { name: string; accountId: string }[] = await device.companionLink.protocol.getUserAccounts();
            const lowerQuery = query.trim().toLowerCase();

            return userAccounts
                .filter(account => lowerQuery.length === 0 || account.name.toLowerCase().includes(lowerQuery))
                .map(account => ({
                    id: account.accountId,
                    name: account.name
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
        });
    }
}
