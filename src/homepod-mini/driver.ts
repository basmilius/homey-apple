import { Driver } from '@basmilius/homey-common';
import Homey from 'homey';
import type { AppleApp } from '../types';
import HomePodMiniPairing from './pairing';

export default class HomePodMiniDriver extends Driver<AppleApp> {
    async onInit(): Promise<void> {
        this.log('HomePodMiniDriver has been initialized.');
    }

    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        const pairing = new HomePodMiniPairing(session, this.getDiscoveryStrategy());

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
