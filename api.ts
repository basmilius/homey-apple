import type { WidgetApiRequest } from '@basmilius/homey-common';
import type AppleApp from './src';

type StateQuery = {
    readonly deviceId: string;
};

type ActionBody = {
    readonly deviceId: string;
    readonly action: 'play_pause' | 'next' | 'prev';
};

async function widgetGetState({ homey, query }: WidgetApiRequest<AppleApp, never, never, StateQuery>) {
    const { deviceId } = query;
    const app = homey.app as AppleApp;
    const device = await app.getDevice(deviceId);

    if (!device) {
        throw new Error('Device not found');
    }

    return {
        playing: device.getCapabilityValue('speaker_playing') ?? false,
        track: device.getCapabilityValue('speaker_track') ?? '',
        artist: device.getCapabilityValue('speaker_artist') ?? '',
        album: device.getCapabilityValue('speaker_album') ?? '',
        artworkUrl: device.getCapabilityValue('artwork_url') ?? null
    };
}

async function widgetPostAction({ homey, body }: WidgetApiRequest<AppleApp, ActionBody>) {
    const { deviceId, action } = body;
    const app = homey.app as AppleApp;
    const device = await app.getDevice(deviceId);

    if (!device) {
        throw new Error('Device not found');
    }

    switch (action) {
        case 'play_pause':
            await device.triggerCapabilityListener('speaker_playing', !device.getCapabilityValue('speaker_playing'));
            break;
        case 'next':
            if (device.hasCapability('speaker_next')) {
                await device.triggerCapabilityListener('speaker_next', true);
            }
            break;
        case 'prev':
            if (device.hasCapability('speaker_prev')) {
                await device.triggerCapabilityListener('speaker_prev', true);
            }
            break;
    }

    return { ok: true };
}

module.exports = {
    widgetGetState,
    widgetPostAction
};
