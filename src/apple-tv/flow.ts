import type { RemoteKey } from '@corewire/devices';
import { Shortcuts } from '@basmilius/homey-common';
import type { AppleApp, AppleTVDevice } from '../types';
import { toRepeatMode } from '../utils';
import type Homey from 'homey';

type AppPlaybackCardId = 'appletv_app_starts_playing' | 'appletv_app_stops_playing';

export default class AppleTVFlow extends Shortcuts<AppleApp> {
    register(): void {
        this.#registerAppPlayback('appletv_app_starts_playing');
        this.#registerAppPlayback('appletv_app_stops_playing');
        this.#registerLaunchApp();
        this.#registerLaunchUrl();
        this.#registerNowPlayingAppBecomes();
        this.#registerNowPlayingAppIs();
        this.#registerPlayUrl();
        this.#registerPlayUrlAtVolume();
        this.#registerRemote();
        this.#registerSetPosition();
        this.#registerSetRepeat();
        this.#registerSetShuffle();
        this.#registerSkipBackward();
        this.#registerSkipForward();
        this.#registerSwitchAccount();
    }

    readonly #appAutocompleteListener = async (query: string, {device}: { device: AppleTVDevice }): Promise<Homey.FlowCard.ArgumentAutocompleteResults> => {
        const launchableApps = device.sdk.supports('apps') ? await device.sdk.apps.list() : [];
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

    async triggerAppPlayback(device: AppleTVDevice, cardId: AppPlaybackCardId, bundleIdentifier: string): Promise<void> {
        try {
            const triggerCard = this.flow.getDeviceTriggerCard(cardId);

            await triggerCard.trigger(device, {}, {
                bundleId: bundleIdentifier
            });
        } catch (err) {
            this.log(device.name, `Failed to trigger ${cardId} card.`, err);
        }
    }

    #registerAppPlayback(cardId: AppPlaybackCardId): void {
        const card = this.flow.getDeviceTriggerCard(cardId);

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

    #registerLaunchApp(): void {
        const launchApp = this.flow.getActionCard('appletv_launch_app');

        type RunArguments = {
            readonly app: AppleApp;
            readonly device: AppleTVDevice;
        };

        launchApp.registerRunListener(async ({app, device}: RunArguments) => {
            await device.sdk.apps.launch(app.id);
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
        };

        launchUrl.registerRunListener(async ({device, url}: RunArguments) => {
            await device.sdk.apps.openUrl(url);
        });
    }

    #registerPlayUrl(): void {
        const playUrl = this.flow.getActionCard('appletv_play_url');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly url: string;
        };

        playUrl.registerRunListener(async ({device, url}: RunArguments) => {
            await device.playUrl(url);
        });
    }

    #registerPlayUrlAtVolume(): void {
        const playUrl = this.flow.getActionCard('appletv_play_url_at_volume');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly url: string;
            readonly volume: number;
        };

        playUrl.registerRunListener(async ({device, url, volume}: RunArguments) => {
            await device.playUrl(url, volume);
        });
    }

    #registerRemote(): void {
        const remote = this.flow.getActionCard('appletv_remote');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly command: string;
        };

        remote.registerRunListener(async ({device, command}: RunArguments) => {
            const sdk = device.sdk;

            // These only exist over Companion Link. The device would send a hold or a double press
            // over AirPlay when Companion Link is down; the card fails instead, as it always did.
            const companionLinkOnly = (key: RemoteKey, mode?: 'hold' | 'double') => {
                if (!device.isCompanionLinkConnected) {
                    throw new Error('Companion Link is not available.');
                }

                return sdk.remote.press(key, {mode});
            };

            const commands: Record<string, () => Promise<void>> = {
                up: () => sdk.remote.press('up'),
                down: () => sdk.remote.press('down'),
                left: () => sdk.remote.press('left'),
                right: () => sdk.remote.press('right'),
                select: () => sdk.remote.press('select'),
                menu: () => sdk.remote.press('menu'),
                home: () => sdk.remote.press('home'),
                play: () => sdk.remote.press('play'),
                pause: () => sdk.remote.press('pause'),
                playPause: () => sdk.remote.press('playPause'),
                next: () => sdk.remote.press('next'),
                previous: () => sdk.remote.press('previous'),
                volumeUp: () => sdk.volume.up(),
                volumeDown: () => sdk.volume.down(),
                mute: () => sdk.remote.press('mute'),
                stop: () => sdk.remote.press('stop'),
                screensaver: () => companionLinkOnly('screensaver'),
                topMenu: () => sdk.remote.press('topMenu'),
                homeHold: () => companionLinkOnly('home', 'hold'),
                doubleTapSelect: () => companionLinkOnly('select', 'double'),
                channelUp: () => sdk.remote.press('channelUp'),
                channelDown: () => sdk.remote.press('channelDown'),
                siri: () => companionLinkOnly('siri'),
                wake: () => sdk.remote.press('wake'),
                suspend: () => sdk.remote.press('suspend')
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
            await device.sdk.playback.seek(Math.floor(position));
        });
    }

    #registerSetRepeat(): void {
        const card = this.flow.getActionCard('appletv_set_repeat');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly mode: string;
        };

        card.registerRunListener(async ({device, mode}: RunArguments) => {
            await device.sdk.playback.setRepeat(toRepeatMode(mode));
        });
    }

    #registerSetShuffle(): void {
        const card = this.flow.getActionCard('appletv_set_shuffle');

        type RunArguments = {
            readonly device: AppleTVDevice;
            readonly shuffle: string;
        };

        card.registerRunListener(async ({device, shuffle}: RunArguments) => {
            await device.sdk.playback.setShuffle(shuffle === 'true' ? 'songs' : 'off');
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
            await device.sdk.accounts.switch(account.id);
        });

        switchAccount.registerArgumentAutocompleteListener('account', async (query: string, {device}: AutocompleteArguments): Promise<Homey.FlowCard.ArgumentAutocompleteResults> => {
            const userAccounts = device.sdk.supports('accounts') ? await device.sdk.accounts.list() : [];
            const lowerQuery = query.trim().toLowerCase();

            return userAccounts
                .filter(account => lowerQuery.length === 0 || account.name.toLowerCase().includes(lowerQuery))
                .map(account => ({
                    id: account.id,
                    name: account.name
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
        });
    }
}
