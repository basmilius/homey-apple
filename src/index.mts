// @ts-ignore
import { enableDebug } from '@basmilius/apple-common';
import Homey from 'homey';

// enableDebug();

export default class AppleApp extends Homey.App {
    async onInit(): Promise<void> {
        this.log('Apple has been initialized');
    }
}
