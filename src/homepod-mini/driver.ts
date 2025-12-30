import Homey from 'homey';
import HomePodBaseDriver from '../homepod-base/driver';
import HomePodBasePairing from '../homepod-base/pairing';

export default class HomePodMiniDriver extends HomePodBaseDriver {
    async onInit(): Promise<void> {
        this.log('HomePod Mini Driver has been initialized.');
    }

    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        const pairing = new HomePodBasePairing(session, this.getDiscoveryStrategy(), this.getDevices());

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
