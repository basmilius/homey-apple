import type AppleApp from './index';
import type AppleTVDevice from './apple-tv/device';
import type AppleTVDriver from './apple-tv/driver';
import type HomePodBaseDevice from './homepod-base/device';
import type HomePodBaseDriver from './homepod-base/driver';

export type {
    AppleApp,
    AppleTVDevice,
    AppleTVDriver,
    HomePodBaseDevice,
    HomePodBaseDriver
};

export type StrategyKey =
    | 'appletv-airplay'
    | 'appletv-companion-link'
    | 'homepod'
    | 'homepod-mini';
