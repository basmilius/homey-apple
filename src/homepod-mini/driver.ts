import Homey from 'homey';
import HomePodBaseDriver from '../homepod-base/driver';
import HomePodMiniPairing from './pairing';

export default class HomePodMiniDriver extends HomePodBaseDriver {
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
