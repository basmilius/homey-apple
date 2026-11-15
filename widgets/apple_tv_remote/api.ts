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

function buildState(device: AppleTVDevice): State {
    return {
        deviceId: device.getData().id,
        deviceName: device.getName(),
        track: safeCapabilityValue(device, 'speaker_track'),
        artist: safeCapabilityValue(device, 'speaker_artist'),
        album: safeCapabilityValue(device, 'speaker_album'),
        playing: safeCapabilityValue(device, 'speaker_playing'),
        artworkUrl: safeCapabilityValue(device, 'artwork_url'),
        onoff: safeCapabilityValue(device, 'onoff')
    };
}

async function send(request: WidgetApiRequest<AppleApp, never, Params>, capabilityId: string, value: any = true): Promise<boolean> {
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
}

export async function get(request: WidgetApiRequest<AppleApp, never, Params>): Promise<State | null> {
    const device = await findDevice<AppleTVDevice>(request, request.params.deviceId);

    if (!device) {
        return null;
    }

    return buildState(device);
}

export async function remote_up(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'remote_up');
}

export async function remote_down(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'remote_down');
}

export async function remote_left(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'remote_left');
}

export async function remote_right(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'remote_right');
}

export async function remote_select(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'remote_select');
}

export async function remote_home(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'remote_home');
}

export async function remote_back(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'remote_back');
}

export async function remote_playpause(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'remote_playpause');
}

export async function remote_previous(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'speaker_prev');
}

export async function remote_next(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'speaker_next');
}

export async function volume_up(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'volume_up');
}

export async function volume_down(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
    return send(request, 'volume_down');
}

export async function mute(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
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
}

export async function power(request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> {
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
}
