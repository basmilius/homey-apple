import Homey from 'homey';

export default class AppleApp extends Homey.App {
    async onInit(): Promise<void> {
        this.log('Apple has been initialized');
    }
}
