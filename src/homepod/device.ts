import HomePodBaseDevice from '../homepod-base/device';
import type HomePodDriver from './driver';

export default class HomePodDevice extends HomePodBaseDevice<HomePodDriver> {
    get discoveryStrategies(): string[] {
        return ['homepod'];
    }
}
