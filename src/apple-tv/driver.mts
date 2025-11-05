import Homey from 'homey';
import AppleTVPairing from './pairing.mjs';

export default class AppleTVDevice extends Homey.Driver {
    async onInit(): Promise<void> {
        this.log('AppleTVDriver has been initialized.');
    }

    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        const pairing = new AppleTVPairing(session, this.getDiscoveryStrategy());

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
