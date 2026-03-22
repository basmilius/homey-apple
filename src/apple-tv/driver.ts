import { Driver } from '@basmilius/homey-common';
import Homey from 'homey';
import type { AppleApp } from '../types';
import AppleTVPairing from './pairing';

export default class AppleTVDriver extends Driver<AppleApp> {
    async onInit(): Promise<void> {
        this.log('Apple TV Driver has been initialized.');
    }

    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        const pairing = new AppleTVPairing(session, this.discovery.getStrategy('airplay'), this.getDevices());

        pairing.on('error', err => {
            this.error(err);
        });

        pairing.on('log', log => {
            this.log(log);
        });

        await pairing.start();
    }
}
