import type { DiscoveryResult } from '@basmilius/apple-common';
import type Homey from 'homey';

export default function (result: Homey.DiscoveryResultMDNSSD): DiscoveryResult {
    const txt = result.txt as Record<string, string>;

    return {
        id: result.id,
        fqdn: result.id,
        address: result.address,
        modelName: txt?.model ?? '',
        familyName: null,
        txt,
        service: {
            port: Number(result.port),
            protocol: 'tcp',
            type: '_'
        },
        packet: null
    } as unknown as DiscoveryResult;
}
