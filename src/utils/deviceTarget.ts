import type { DeviceTarget } from '@corewire/devices';
import type Homey from 'homey';

/**
 * The target a device connects to, from a Homey AirPlay discovery result.
 */
export default function toDeviceTarget(result: Homey.DiscoveryResultMDNSSD): DeviceTarget {
    return {
        address: result.address,
        port: Number(result.port),
        txt: result.txt as Record<string, string>,
        id: result.id
    };
}
