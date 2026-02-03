import HomePodBaseDriver from '../homepod-base/driver';

export default class HomePodDriver extends HomePodBaseDriver {
    get modelFilter(): RegExp {
        return /AudioAccessory[16],\d/;
    }

    async onInit(): Promise<void> {
        this.log('HomePod Driver has been initialized.');
    }
}
