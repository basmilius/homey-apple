/**
 * Returns null instead of throwing when the device does not have the capability.
 */
export default function safeCapabilityValue(device: { getCapabilityValue(capabilityId: string): any }, capabilityId: string): any {
    try {
        return device.getCapabilityValue(capabilityId);
    } catch {
        return null;
    }
}
