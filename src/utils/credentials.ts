import { Credentials } from '@apple-protocols/devices';
import type { Device } from '@basmilius/homey-common';
import type { AppleApp } from '../types';

// The hex fields are what releases on @basmilius/apple-sdk read. They stay untouched and are written
// next to the string form, so a rollback to such a release keeps every pairing.
const FIELDS_KEY = 'credentials';
const STRING_KEY = 'credentialsString';

/**
 * The store values of a new pairing.
 */
export function credentialsStore(credentials: Credentials): Record<string, unknown> {
    return {
        [FIELDS_KEY]: credentials.toFields(),
        [STRING_KEY]: credentials.toString()
    };
}

/**
 * Reads the string form first and falls back to the hex fields, which it then also stores as a
 * string. Returns null when neither is stored or readable.
 */
export async function readCredentials(device: Device<AppleApp, any>): Promise<Credentials | null> {
    const stored = device.getStoreValue(STRING_KEY);

    if (typeof stored === 'string' && stored.length > 0) {
        try {
            return Credentials.parse(stored);
        } catch (err) {
            device.error('Stored credentials string is unreadable, falling back to the hex fields.', err);
        }
    }

    const fields = device.getStoreValue(FIELDS_KEY);

    if (!fields) {
        return null;
    }

    let credentials: Credentials;

    try {
        credentials = Credentials.parse(fields);
    } catch (err) {
        device.error('Stored credentials are unreadable.', err);
        return null;
    }

    try {
        await device.setStoreValue(STRING_KEY, credentials.toString());
    } catch (err) {
        device.error('Failed to store the credentials string.', err);
    }

    return credentials;
}
