import type AppleApp from './index';
import type AppleTVDevice from './apple-tv/device';
import type HomePodBaseDevice from './homepod-base/device';

export type {
    AppleApp,
    AppleTVDevice,
    HomePodBaseDevice
};

export type StrategyKey =
    | 'appletv-airplay'
    | 'appletv-companion-link'
    | 'homepod'
    | 'homepod-mini';
