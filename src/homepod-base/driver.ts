import { Driver } from '@basmilius/homey-common';
import type { AppleApp } from '../types';
import type Homey from 'homey';
import HomePodBasePairing from './pairing';

export default abstract class HomePodBaseDriver extends Driver<AppleApp> {
    abstract get modelFilter(): RegExp;

    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        const pairing = new HomePodBasePairing(session, this.discovery.getStrategy('airplay'), this.modelFilter, this.getDevices());

        pairing.on('error', err => {
            // todo: Show error screen or something.
            this.error(err);
        });

        pairing.on('log', log => {
            this.log(log);
        });

        await pairing.start();
    }
}
