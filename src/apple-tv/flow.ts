import { Proto } from '@basmilius/apple-sdk';
import { Shortcuts } from '@basmilius/homey-common';
import type { AppleApp, AppleTVDevice } from '../types';
import { repeatModeToProto } from '../utils';
import type Homey from 'homey';

export default class AppleTVFlow extends Shortcuts<AppleApp> {
    register(): void {
        this.#registerLaunchApp();
        this.#registerLaunchUrl();
        this.#registerNowPlayingAppBecomes();
        this.#registerNowPlayingAppIs();
        this.#registerRemote();
        this.#registerSetPosition();
        this.#registerSetRepeat();
        this.#registerSetShuffle();
        this.#registerSkipBackward();
        this.#registerSkipForward();
        this.#registerSwitchAccount();
    }

    readonly #appAutocompleteListener = async (query: string, {device}: { device: AppleTVDevice }): Promise<Homey.FlowCard.ArgumentAutocompleteResults> => {
        const launchableApps = await device.sdk.apps?.list() ?? [];
        const lowerQuery = query.trim().toLowerCase();

        return launchableApps
            .filter(app => lowerQuery.length === 0 || app.name.toLowerCase().includes(lowerQuery))
            .map(app => ({
                id: app.bundleId,
                name: app.name,
                description: app.bundleId
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    };

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

    async triggerNowPlayingAppBecomes(device: AppleTVDevice, bundleIdentifier: string, displayName: string): Promise<void> {
        try {
            const triggerCard = this.flow.getDeviceTriggerCard('appletv_now_playing_app_becomes');

            await triggerCard.trigger(device, {}, {
                bundleId: bundleIdentifier,
                displayName
            });
        } catch (err) {
            this.log(device.name, 'Failed to trigger now playing app becomes card.', err);
        }
    }

    #registerLaunchApp(): void {
        const launchApp = this.flow.getActionCard('appletv_launch_app');

        type RunArguments = {
            readonly app: AppleApp;
            readonly device: AppleTVDevice;
        };

        launchApp.registerRunListener(async ({app, device}: RunArguments) => {
            await device.sdk.apps?.launch(app.id);
        });

        launchApp.registerArgumentAutocompleteListener('app', this.#appAutocompleteListener);
    }

    #registerNowPlayingAppBecomes(): void {
        const card = this.flow.getDeviceTriggerCard('appletv_now_playing_app_becomes');

        type RunArguments = {
            readonly app: AppleApp;
        };

        type State = {
            readonly bundleId: string;
        };

        card.registerRunListener(async (args: RunArguments, state: State) => {
            return args.app.id === state.bundleId;
        });

        card.registerArgumentAutocompleteListener('app', this.#appAutocompleteListener);
    }

    #registerNowPlayingAppIs(): void {
        const card = this.flow.getConditionCard('appletv_now_playing_app_is');

        type RunArguments = {
            readonly app: AppleApp;
            readonly device: AppleTVDevice;
        };

        card.registerRunListener(async ({app, device}: RunArguments) => {
            return device.currentNowPlayingBundleId === app.id;
        });

        card.registerArgumentAutocompleteListener('app', this.#appAutocompleteListener);
    }

    #registerLaunchUrl(): void {
        const launchUrl = this.flow.getActionCard('appletv_launch_url');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly url: string;
        }

        launchUrl.registerRunListener(async ({device, url}: RunArguments) => {
            await device.sdk.apps?.openUrl(url);
        });
    }

    #registerRemote(): void {
        const remote = this.flow.getActionCard('appletv_remote');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly command: string;
        }

        remote.registerRunListener(async ({device, command}: RunArguments) => {
            const sdk = device.sdk;

            const commands: Record<string, () => Promise<void>> = {
                up: () => sdk.remote.up(),
                down: () => sdk.remote.down(),
                left: () => sdk.remote.left(),
                right: () => sdk.remote.right(),
                select: () => sdk.remote.select(),
                menu: () => sdk.remote.menu(),
                home: () => sdk.remote.home(),
                play: () => sdk.remote.play(),
                pause: () => sdk.remote.pause(),
                playPause: () => sdk.remote.playPause(),
                next: () => sdk.remote.next(),
                previous: () => sdk.remote.previous(),
                volumeUp: () => sdk.volume.up(),
                volumeDown: () => sdk.volume.down(),
                mute: () => sdk.remote.mute(),
                stop: () => sdk.remote.stop(),
                screensaver: () => {
                    if (!sdk.companionLink) { throw new Error('Companion Link is not available.'); }
                    return sdk.companionLink.pressButton('Screensaver');
                },
                topMenu: () => sdk.remote.topMenu(),
                homeHold: () => {
                    if (!sdk.companionLink) { throw new Error('Companion Link is not available.'); }
                    return sdk.companionLink.pressButton('Home', 'Hold');
                },
                doubleTapSelect: () => {
                    if (!sdk.companionLink) { throw new Error('Companion Link is not available.'); }
                    return sdk.companionLink.pressButton('Select', 'DoubleTap');
                },
                channelUp: () => sdk.remote.channelUp(),
                channelDown: () => sdk.remote.channelDown(),
                siri: () => {
                    if (!sdk.companionLink) { throw new Error('Companion Link is not available.'); }
                    return sdk.companionLink.pressButton('Siri');
                },
                wake: () => sdk.remote.wake(),
                suspend: () => sdk.remote.suspend()
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
            await device.sdk.playback.seekTo(Math.floor(position));
        });
    }

    #registerSetRepeat(): void {
        const card = this.flow.getActionCard('appletv_set_repeat');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly mode: string;
        };

        card.registerRunListener(async ({device, mode}: RunArguments) => {
            await device.sdk.playback.setRepeatMode(repeatModeToProto[mode] ?? Proto.RepeatMode_Enum.Off);
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
            await device.sdk.playback.setShuffleMode(mode);
        });
    }

    #registerSkipBackward(): void {
        const card = this.flow.getActionCard('appletv_skip_backward');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.sdk.playback.skipBackward(Math.floor(seconds));
        });
    }

    #registerSkipForward(): void {
        const card = this.flow.getActionCard('appletv_skip_forward');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly seconds: number;
        };

        card.registerRunListener(async ({device, seconds}: RunArguments) => {
            await device.sdk.playback.skipForward(Math.floor(seconds));
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
            await device.sdk.accounts?.switch(account.id);
        });

        switchAccount.registerArgumentAutocompleteListener('account', async (query: string, {device}: AutocompleteArguments): Promise<Homey.FlowCard.ArgumentAutocompleteResults> => {
            const userAccounts = await device.sdk.accounts?.list() ?? [];
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
