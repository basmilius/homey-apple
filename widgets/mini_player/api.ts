import { Proto } from '@basmilius/apple-airplay';
import type { WidgetApiRequest } from '@basmilius/homey-common';
import type AppleApp from '../../src';
import type AppleTVDevice from '../../src/apple-tv/device';
import type HomePodBaseDevice from '../../src/homepod-base/device';

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

type State = {
    readonly deviceId: string;
    readonly deviceName: string;
    readonly track: string | null;
    readonly artist: string | null;
    readonly album: string | null;
    readonly playing: boolean | null;
    readonly position: number | null;
    readonly duration: number | null;
    readonly volume: number | null;
    readonly artworkUrl: string | null;
    readonly onoff: boolean | null;
    readonly shuffle: boolean;
    readonly repeat: string;
    readonly positionTimestamp: number;
    readonly features: {
        readonly previous: boolean;
        readonly next: boolean;
        readonly shuffle: boolean;
        readonly repeat: boolean;
    };
};

const findDevice = async ({homey: {app}}: WidgetApiRequest<AppleApp, any, Params>, deviceId: string): Promise<Device | null> =>
    app.getDevice<Device>(deviceId);

const isAppleTVDevice = (device: Device): device is AppleTVDevice =>
    'companionLink' in device;

const buildState = (device: Device): State => {
    const cap = (name: string): any => {
        try {
            return device.getCapabilityValue(name);
        } catch {
            return null;
        }
    };

    const logic = device.airplayLogic;

    return {
        deviceId: device.getData().id,
        deviceName: device.getName(),
        track: cap('speaker_track'),
        artist: cap('speaker_artist'),
        album: cap('speaker_album'),
        playing: cap('speaker_playing'),
        position: logic.position,
        duration: cap('speaker_duration'),
        volume: cap('volume_set'),
        artworkUrl: cap('artwork_url'),
        onoff: cap('onoff'),
        shuffle: logic.shuffle,
        repeat: logic.repeat,
        positionTimestamp: logic.positionTimestamp || Date.now(),
        features: logic.features,
    };
};

export const get = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<State | null> => {
    const device = await findDevice(request, request.params.deviceId);
    if (!device) {
        return null;
    }

    return buildState(device);
};

export const set_playing = async (request: WidgetApiRequest<AppleApp, never, Params>): Promise<boolean> => {
    const device = await findDevice(request, request.params.deviceId);
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
    const device = await findDevice(request, request.params.deviceId);
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
    const device = await findDevice(request, request.params.deviceId);
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
    const device = await findDevice(request, request.params.deviceId);
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
    const device = await findDevice(request, request.params.deviceId);
    if (!device || !isAppleTVDevice(device)) {
        return false;
    }

    const newMode = request.body?.shuffle
        ? Proto.ShuffleMode_Enum.Songs
        : Proto.ShuffleMode_Enum.Off;

    try {
        await device.airplay.remote.commandSetShuffleMode(newMode);
        return true;
    } catch {
        return false;
    }
};

export const set_repeat = async (request: WidgetApiRequest<AppleApp, RepeatBody, Params>): Promise<boolean> => {
    const device = await findDevice(request, request.params.deviceId);
    if (!device || !isAppleTVDevice(device)) {
        return false;
    }

    const modeMap: Record<string, Proto.RepeatMode_Enum> = {
        off: Proto.RepeatMode_Enum.Off,
        all: Proto.RepeatMode_Enum.All,
        one: Proto.RepeatMode_Enum.One,
    };

    const newMode = modeMap[request.body?.repeat] ?? Proto.RepeatMode_Enum.Off;

    try {
        await device.airplay.remote.commandSetRepeatMode(newMode);
        return true;
    } catch {
        return false;
    }
};
