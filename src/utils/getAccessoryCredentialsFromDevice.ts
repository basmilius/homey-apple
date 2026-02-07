import type { AccessoryCredentials } from '@basmilius/apple-common';
import type { Device } from '@basmilius/homey-common';
import type { AppleApp } from '../types';

export default function (device: Device<AppleApp, any>): AccessoryCredentials | null {
    const credentials = device.getStoreValue('credentials');

    if (!credentials) {
        return null;
    }

    return {
        accessoryIdentifier: credentials.accessoryIdentifier,
        accessoryLongTermPublicKey: Buffer.from(credentials.accessoryLongTermPublicKey, 'hex'),
        pairingId: Buffer.from(credentials.pairingId, 'hex'),
        publicKey: Buffer.from(credentials.publicKey, 'hex'),
        secretKey: Buffer.from(credentials.secretKey, 'hex')
    };
}
