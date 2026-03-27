import type { Device, WidgetApiRequest } from '@basmilius/homey-common';
import type AppleApp from '../src';

export async function findDevice<T extends Device<AppleApp, any>>(
    request: WidgetApiRequest<AppleApp, any, { deviceId: string }>,
    deviceId: string
): Promise<T | null> {
    return request.homey.app.getDevice<T>(deviceId);
}
