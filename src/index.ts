import { reporter } from '@basmilius/apple-common';
import { App } from '@basmilius/homey-common';

reporter.isEnabled('error');

export default class AppleApp extends App<AppleApp> {
    async onInit(): Promise<void> {
        this.log('Apple has been initialized');
    }
}
