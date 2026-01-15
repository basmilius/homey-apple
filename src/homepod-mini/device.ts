import HomePodBaseDevice from '../homepod-base/device';
import type HomePodMiniDriver from './driver';

export default class HomePodMiniDevice extends HomePodBaseDevice<HomePodMiniDriver> {
    get discoveryStrategies(): string[] {
        return ['homepod-mini'];
    }
}
