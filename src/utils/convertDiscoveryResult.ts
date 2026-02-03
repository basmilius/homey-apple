import type { DiscoveryResult } from '@basmilius/apple-common';
import type Homey from 'homey';

export default function (result: Homey.DiscoveryResultMDNSSD): DiscoveryResult {
    return {
        id: result.id,
        name: result.name,
        address: result.address,
        service: {
            port: result.port,
        },
        txt: result.txt,
    }
}
