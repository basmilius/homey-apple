import { AirPlayConnection } from '../connection';
import HomePodBaseDevice from '../homepod-base/device';
import type HomePodDriver from './driver';

export default class HomePodDevice extends HomePodBaseDevice<HomePodDriver> {
    async createAirPlayConnection(): Promise<AirPlayConnection> {
        return new AirPlayConnection(this, 'homepod');
    }
}
