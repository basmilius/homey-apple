import HomePodBaseDriver from '../homepod-base/driver';

export default class HomePodMiniDriver extends HomePodBaseDriver {
    get modelFilter(): RegExp {
        return /AudioAccessory5,\d/;
    }

    async onInit(): Promise<void> {
        await super.onInit();
        this.log('HomePod Mini Driver has been initialized.');
    }
}
