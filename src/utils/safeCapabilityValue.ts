/**
 * Safely retrieves a capability value from a device, returning null if
 * the capability doesn't exist or an error occurs.
 */
export default function safeCapabilityValue(device: { getCapabilityValue(capabilityId: string): any }, capabilityId: string): any {
    try {
        return device.getCapabilityValue(capabilityId);
    } catch {
        return null;
    }
}
