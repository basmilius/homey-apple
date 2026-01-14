import { AirPlayConnection } from '../connection';
import HomePodBaseDevice from '../homepod-base/device';
import type HomePodMiniDriver from './driver';

export default class HomePodMiniDevice extends HomePodBaseDevice<HomePodMiniDriver> {
    async createAirPlayConnection(): Promise<AirPlayConnection> {
        return new AirPlayConnection(this, 'homepod-mini');
    }
}
