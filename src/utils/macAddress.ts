/**
 * Extracts and normalizes the MAC address from mDNS TXT records.
 *
 * Looks for the MAC in common Apple device TXT fields:
 * - `deviceid`: Used by AirPlay services
 * - `rpmrtid`: Used by Companion Link services
 *
 * @param txt The TXT records from an mDNS discovery result.
 * @returns The normalized MAC address (uppercase, colon-separated) or null.
 */
export default function extractMacAddress(txt: Record<string, string> | null | undefined): string | null {
    if (!txt) {
        return null;
    }

    const raw = txt.deviceid ?? txt.rpmrtid ?? null;

    if (!raw) {
        return null;
    }

    return normalizeMacAddress(raw);
}

/**
 * Normalizes a MAC address to uppercase, colon-separated format.
 *
 * @param mac A MAC address in any common format.
 * @returns The normalized MAC address (e.g. `AA:BB:CC:DD:EE:FF`).
 */
function normalizeMacAddress(mac: string): string {
    const clean = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

    if (clean.length !== 12) {
        return mac.toUpperCase();
    }

    return clean.match(/.{2}/g)!.join(':');
}
