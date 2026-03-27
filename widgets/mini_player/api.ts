import type { WidgetApiRequest } from '@basmilius/homey-common';
import type AppleApp from '../../src';
import type AppleTVDevice from '../../src/apple-tv/device';
import type HomePodBaseDevice from '../../src/homepod-base/device';
import type { MiniPlayerState } from '../../src/logic';
import { repeatModeToCapability } from '../../src/utils';
import { findDevice } from '../shared';

type Params = {
    readonly deviceId: string;
};

type VolumeBody = {
    readonly volume: number;
};

type ShuffleBody = {
    readonly shuffle: boolean;
};

type RepeatBody = {
    readonly repeat: string;
};

type Device = AppleTVDevice | HomePodBaseDevice<any>;

export const get = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<MiniPlayerState | null> => {
    const device = await findDevice<Device>(request, request.params.deviceId);
    if (!device) {
        return null;
    }

    return device.airplayLogic.getState();
};

export const set_playing = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> => {
    const device = await findDevice<Device>(request, request.params.deviceId);
    if (!device) {
        return false;
    }

    try {
        const current = device.getCapabilityValue('speaker_playing');
        await device.triggerCapabilityListener('speaker_playing', !current);
        return true;
    } catch {
        return false;
    }
};

export const set_next = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> => {
    const device = await findDevice<Device>(request, request.params.deviceId);
    if (!device) {
        return false;
    }

    try {
        await device.triggerCapabilityListener('speaker_next', true);
        return true;
    } catch {
        return false;
    }
};

export const set_previous = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> => {
    const device = await findDevice<Device>(request, request.params.deviceId);
    if (!device) {
        return false;
    }

    try {
        await device.triggerCapabilityListener('speaker_prev', true);
        return true;
    } catch {
        return false;
    }
};

export const set_volume = async (request: WidgetApiRequest<AppleApp, VolumeBody, Params>): Promise<boolean> => {
    const device = await findDevice<Device>(request, request.params.deviceId);
    const volume = request.body?.volume;

    if (!device || volume === undefined || volume === null) {
        return false;
    }

    if (!device.hasCapability('volume_set')) {
        return false;
    }

    const volumeValue = Number(volume);

    if (isNaN(volumeValue) || volumeValue < 0 || volumeValue > 1) {
        return false;
    }

    try {
        await device.triggerCapabilityListener('volume_set', volumeValue);
        return true;
    } catch {
        return false;
    }
};

export const set_shuffle = async (request: WidgetApiRequest<AppleApp, ShuffleBody, Params>): Promise<boolean> => {
    const device = await findDevice<Device>(request, request.params.deviceId);
    if (!device || !device.hasCapability('speaker_shuffle')) {
        return false;
    }

    try {
        await device.triggerCapabilityListener('speaker_shuffle', !!request.body?.shuffle);
        return true;
    } catch {
        return false;
    }
};

export const set_repeat = async (request: WidgetApiRequest<AppleApp, RepeatBody, Params>): Promise<boolean> => {
    const device = await findDevice<Device>(request, request.params.deviceId);
    if (!device || !device.hasCapability('speaker_repeat')) {
        return false;
    }

    try {
        await device.triggerCapabilityListener('speaker_repeat', repeatModeToCapability[request.body?.repeat] ?? 'none');
        return true;
    } catch {
        return false;
    }
};
