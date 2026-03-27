import type { WidgetApiRequest } from '@basmilius/homey-common';
import type AppleApp from '../../src';
import type AppleTVDevice from '../../src/apple-tv/device';
import { safeCapabilityValue } from '../../src/utils';
import { findDevice } from '../shared';

type Params = {
    readonly deviceId: string;
};

type State = {
    readonly deviceId: string;
    readonly deviceName: string;
    readonly track: string | null;
    readonly artist: string | null;
    readonly album: string | null;
    readonly playing: boolean | null;
    readonly artworkUrl: string | null;
    readonly onoff: boolean | null;
};

const buildState = (device: AppleTVDevice): State => ({
    deviceId: device.getData().id,
    deviceName: device.getName(),
    track: safeCapabilityValue(device, 'speaker_track'),
    artist: safeCapabilityValue(device, 'speaker_artist'),
    album: safeCapabilityValue(device, 'speaker_album'),
    playing: safeCapabilityValue(device, 'speaker_playing'),
    artworkUrl: safeCapabilityValue(device, 'artwork_url'),
    onoff: safeCapabilityValue(device, 'onoff'),
});

const send = async (request: WidgetApiRequest<AppleApp, never, Params>, capabilityId: string, value: any = true): Promise<boolean> => {
    const device = await findDevice<AppleTVDevice>(request, request.params.deviceId);
    if (!device) {
        return false;
    }

    try {
        await device.triggerCapabilityListener(capabilityId, value);
        return true;
    } catch {
        return false;
    }
};

export const get = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<State | null> => {
    const device = await findDevice<AppleTVDevice>(request, request.params.deviceId);
    if (!device) {
        return null;
    }

    return buildState(device);
};

export const remote_up = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'remote_up');

export const remote_down = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'remote_down');

export const remote_left = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'remote_left');

export const remote_right = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'remote_right');

export const remote_select = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'remote_select');

export const remote_home = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'remote_home');

export const remote_back = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'remote_back');

export const remote_playpause = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'remote_playpause');

export const remote_previous = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'speaker_prev');

export const remote_next = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'speaker_next');

export const volume_up = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'volume_up');

export const volume_down = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> =>
    send(request, 'volume_down');

export const mute = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> => {
    const device = await findDevice<AppleTVDevice>(request, request.params.deviceId);
    if (!device) {
        return false;
    }

    try {
        const current = device.getCapabilityValue('volume_mute');
        await device.triggerCapabilityListener('volume_mute', !current);
        return true;
    } catch {
        return false;
    }
};

export const power = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> => {
    const device = await findDevice<AppleTVDevice>(request, request.params.deviceId);
    if (!device) {
        return false;
    }

    try {
        const current = device.getCapabilityValue('onoff');
        await device.triggerCapabilityListener('onoff', !current);
        return true;
    } catch {
        return false;
    }
};
