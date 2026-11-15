/**
 * Reads the MAC address from the TXT records of a discovery result, as `AA:BB:CC:DD:EE:FF`, or
 * null when there is none.
 */
export default function extractMacAddress(txt: Record<string, string> | null | undefined): string | null {
    if (!txt) {
        return null;
    }

    const raw = txt.deviceid ?? txt.mac ?? null;

    if (!raw) {
        return null;
    }

    return normalizeMacAddress(raw);
}

/**
 * Writes a MAC address in any common format as `AA:BB:CC:DD:EE:FF`, or returns null when it does
 * not have 12 hex digits.
 */
function normalizeMacAddress(mac: string): string | null {
    const clean = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

    if (clean.length !== 12) {
        return null;
    }

    return clean.match(/.{2}/g)!.join(':');
}
