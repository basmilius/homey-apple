import { App } from '@basmilius/homey-common';

export default class AppleApp extends App<AppleApp> {
    async onInit(): Promise<void> {
        this.log('Apple has been initialized');
    }
}
