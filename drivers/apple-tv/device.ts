module.exports = require('../../src/apple-tv/device.mjs').default;

// // @ts-ignore
// import type { AirPlay, Proto } from '@basmilius/apple-airplay';
// // @ts-ignore
// import type { CompanionLink } from '@basmilius/apple-companion-link';
// import Homey, { DiscoveryResultMDNSSD, Image } from 'homey';
// import driverJson from './driver.compose.json';
//
// const NO_DATA = Symbol();
//
// module.exports = class AppleTVDevice extends Homey.Device {
//
//     private artwork?: Image;
//     public airPlay!: AirPlay;
//     public companionLink!: CompanionLink;
//
//     async onInit() {
//         const settings = this.getSettings();
//         const store = this.getStore();
//
//         this.log('AppleTV device is initializing...', {settings, store});
//
//         await this.updateCapabilities();
//
//         const [apaddress, apport] = await this.discoverAirPlay(store.id);
//         const [claddress, clport] = await this.discoverCompanionLink(store.id);
//
//         await this.setupProtocol(apaddress, apport, claddress, clport);
//         await this.pairVerifyAirPlay(store.credentials);
//         await this.pairVerifyCompanionLink(store.credentials);
//
//         await this.registerNowPlaying();
//         await this.registerOnOff();
//         await this.registerRemote();
//         await this.registerVolume();
//
//         await this.companionLink.api._unsubscribe('_iMC');
//
//         this.log('AppleTV is connected!');
//     }
//
//     async onUninit(): Promise<void> {
//         await this.artwork?.unregister();
//
//         await this.airPlay?.disconnect();
//         await this.companionLink?.disconnect();
//
//         this.airPlay = undefined;
//         this.companionLink = undefined;
//     }
//
//     async onAdded() {
//         this.log('AppleTV has been added');
//     }
//
//     async onSettings({oldSettings, newSettings, changedKeys}: any): Promise<string | void> {
//         this.log('AppleTV settings where changed');
//     }
//
//     async onRenamed(name: string) {
//         this.log('AppleTV was renamed');
//     }
//
//     async onDeleted() {
//         this.log('AppleTV has been deleted');
//     }
//
//     async discoverAirPlay(id: string): Promise<[string, number]> {
//         const discovery = this.homey.discovery.getStrategy('airplay');
//
//         return new Promise(resolve => {
//             const discoveryResult: DiscoveryResultMDNSSD = discovery.getDiscoveryResult(id) as DiscoveryResultMDNSSD;
//
//             if (discoveryResult) {
//                 resolve([discoveryResult.address, Number(discoveryResult.port)]);
//                 return;
//             }
//
//             discovery.on('result', result => {
//                 if (result.id !== id) {
//                     return;
//                 }
//
//                 resolve([result.address, Number(result.port)]);
//             });
//         });
//     }
//
//     async discoverCompanionLink(id: string): Promise<[string, number]> {
//         const discovery = this.homey.discovery.getStrategy('companion-link');
//
//         return new Promise(resolve => {
//             const discoveryResult: DiscoveryResultMDNSSD = discovery.getDiscoveryResult(id) as DiscoveryResultMDNSSD;
//
//             if (discoveryResult) {
//                 resolve([discoveryResult.address, Number(discoveryResult.port)]);
//                 return;
//             }
//
//             discovery.on('result', result => {
//                 if (result.id !== id) {
//                     return;
//                 }
//
//                 resolve([result.address, Number(result.port)]);
//             });
//         });
//     }
//
//     async pairVerifyAirPlay(credentials: Record<string, string>): Promise<void> {
//         let lastPlaybackStateTimestamp: number = 0;
//
//         // @ts-ignore
//         const {Proto} = await import('@basmilius/apple-airplay');
//
//         const keys = await this.airPlay.verify.start({
//             accessoryIdentifier: credentials.accessoryIdentifier,
//             accessoryLongTermPublicKey: Buffer.from(credentials.accessoryLongTermPublicKey, 'hex'),
//             pairingId: Buffer.from(credentials.pairingId, 'hex'),
//             publicKey: Buffer.from(credentials.publicKey, 'hex'),
//             secretKey: Buffer.from(credentials.secretKey, 'hex')
//         });
//
//         await this.airPlay.rtsp.enableEncryption(
//             keys.accessoryToControllerKey,
//             keys.controllerToAccessoryKey
//         );
//
//         await this.airPlay.setupEventStream(keys.pairingId, keys.sharedSecret);
//         await this.airPlay.setupDataStream(keys.sharedSecret);
//
//         this.homey.setInterval(() => this.airPlay?.feedback(), 2000);
//
//         await this.airPlay.dataStream.exchange(this.airPlay.dataStream.messages.deviceInfo(keys.pairingId));
//
//         this.airPlay.dataStream.addEventListener('deviceInfo', async (_: CustomEvent) => {
//             await this.airPlay.dataStream.exchange(this.airPlay.dataStream.messages.setConnectionState());
//             await this.airPlay.dataStream.exchange(this.airPlay.dataStream.messages.clientUpdatesConfig());
//         });
//
//         this.airPlay.dataStream.addEventListener('setState', async (evt: CustomEvent) => {
//             const message = evt.detail as Proto.SetStateMessage;
//             const contentItem = message.playbackQueue?.contentItems?.[0];
//             const metadata = contentItem?.metadata ?? null;
//
//             if (lastPlaybackStateTimestamp > message.playbackStateTimestamp) {
//                 return;
//             }
//
//             lastPlaybackStateTimestamp = message.playbackStateTimestamp;
//
//             // if (lastPlaybackStateTimestamp < message.playbackStateTimestamp) {
//             //     lastPlaybackStateTimestamp = message.playbackStateTimestamp;
//                 await this.setCapabilityValue('speaker_playing', message.playbackState === Proto.PlaybackState_Enum.Playing);
//             // }
//
//             this.log(metadata);
//             this.log(metadata?.nowPlayingInfoData.toString());
//             this.log(`playbackState = ${message.playbackState}; playbackStateTimestamp = ${message.playbackStateTimestamp}`);
//
//             if (!metadata) {
//                 return;
//             }
//
//             await this.setCapabilityValue('speaker_album', metadata.albumName);
//             await this.setCapabilityValue('speaker_artist', metadata.trackArtistName);
//             await this.setCapabilityValue('speaker_track', metadata.title);
//             await this.setCapabilityValue('speaker_duration', metadata.duration);
//             await this.setCapabilityValue('speaker_position', metadata.elapsedTime);
//
//             this.artwork?.unregister();
//             this.artwork = undefined;
//
//             if (metadata.artworkAvailable && metadata.artworkURL) {
//                 this.artwork = await this.homey.images.createImage();
//                 this.artwork.setUrl(metadata.artworkURL);
//                 await this.setAlbumArtImage(this.artwork);
//                 await this.artwork.update();
//                 // this.homey.setTimeout(() => this.artwork.update(), 1000);
//             }
//         });
//     }
//
//     async pairVerifyCompanionLink(credentials: Record<string, string>): Promise<void> {
//         const keys = await this.companionLink.verify.start({
//             accessoryIdentifier: credentials.accessoryIdentifier,
//             accessoryLongTermPublicKey: Buffer.from(credentials.accessoryLongTermPublicKey, 'hex'),
//             pairingId: Buffer.from(credentials.pairingId, 'hex'),
//             publicKey: Buffer.from(credentials.publicKey, 'hex'),
//             secretKey: Buffer.from(credentials.secretKey, 'hex')
//         });
//
//         await this.companionLink.socket.enableEncryption(
//             keys.accessoryToControllerKey,
//             keys.controllerToAccessoryKey
//         );
//
//         await this.companionLink.api._systemInfo(credentials.pairingId);
//         await this.companionLink.api._touchStart();
//         await this.companionLink.api._sessionStart();
//         await this.companionLink.api._tvrcSessionStart();
//     }
//
//     async setupProtocol(apaddress: string, apport: number, claddress: string, clport: number): Promise<void> {
//         // @ts-ignore
//         const {AirPlay} = await import('@basmilius/apple-airplay');
//
//         // @ts-ignore
//         const {CompanionLink} = await import('@basmilius/apple-companion-link');
//
//         this.airPlay = new AirPlay({
//             address: apaddress,
//             service: {port: apport}
//         });
//
//         this.companionLink = new CompanionLink({
//             address: claddress,
//             service: {port: clport}
//         });
//
//         await this.airPlay.connect();
//         await this.companionLink.connect();
//     }
//
//     async registerNowPlaying(): Promise<void> {
//         this.registerCapabilityListener('speaker_playing', async (value: boolean) => {
//             if (value) {
//                 await this.companionLink.api.mediaControlCommand('Play');
//             } else {
//                 await this.companionLink.api.mediaControlCommand('Pause');
//             }
//         });
//
//         this.registerCapabilityListener('speaker_next', async () => {
//             await this.companionLink.api.mediaControlCommand('NextTrack');
//         });
//
//         this.registerCapabilityListener('speaker_prev', async () => {
//             await this.companionLink.api.mediaControlCommand('PreviousTrack');
//         });
//     }
//
//     async registerOnOff(): Promise<void> {
//         const state = await this.companionLink.api.getAttentionState();
//
//         this.registerCapabilityListener('onoff', async (value: boolean) => {
//             if (value) {
//                 await this.companionLink.api.pressButton('Wake');
//             } else {
//                 await this.companionLink.api.pressButton('Sleep');
//             }
//         });
//
//         await this.setCapabilityValue('onoff', state === 'awake' || state === 'screensaver');
//
//         await this.companionLink.api._subscribe('TVSystemStatus', (evt: CustomEvent) => {
//             const {state} = evt.detail;
//
//             this.setCapabilityValue('onoff', state === 0x02 || state === 0x03);
//         });
//     }
//
//     async registerRemote(): Promise<void> {
//         const keys = driverJson.capabilities.filter(k => k.startsWith('remote_'));
//
//         this.registerMultipleCapabilityListener(keys, async values => {
//             values.remote_up === true && await this.companionLink.api.pressButton('Up');
//             values.remote_down === true && await this.companionLink.api.pressButton('Down');
//             values.remote_left === true && await this.companionLink.api.pressButton('Left');
//             values.remote_right === true && await this.companionLink.api.pressButton('Right');
//             values.remote_select === true && await this.companionLink.api.pressButton('Select');
//             values.remote_home === true && await this.companionLink.api.pressButton('Home');
//             values.remote_back === true && await this.companionLink.api.pressButton('Menu');
//             values.remote_playpause === true && await this.companionLink.api.pressButton('PlayPause');
//             values.remote_siri === true && await this.companionLink.api.pressButton('Siri', 'Hold', 1000);
//         }, 0);
//     }
//
//     async registerVolume(): Promise<void> {
//         this.registerCapabilityListener('volume_down', async () => {
//             await this.companionLink.api.pressButton('VolumeDown');
//         });
//
//         this.registerCapabilityListener('volume_up', async () => {
//             await this.companionLink.api.pressButton('VolumeUp');
//         });
//
//         this.registerCapabilityListener('volume_mute', async () => {
//             await this.companionLink.api.pressButton('PageUp');
//         });
//     }
//
//     async updateCapabilities(): Promise<void> {
//         const currentCapabilities = this.getCapabilities();
//         const availableCapabilities = driverJson.capabilities;
//
//         for (const capability of availableCapabilities) {
//             if (currentCapabilities.includes(capability)) {
//                 continue;
//             }
//
//             await this.addCapability(capability);
//         }
//
//         for (const capability of currentCapabilities) {
//             if (availableCapabilities.includes(capability)) {
//                 continue;
//             }
//
//             await this.removeCapability(capability);
//         }
//     }
// };
//
// class NowPlayingInfo {
//     get objects(): Record<number, unknown> {
//         return this.#plist.$objects;
//     }
//
//     get valid(): boolean {
//         return this.#plist && this.#plist.$objects && this.#plist.$objects[1];
//     }
//
//     readonly #plist: any;
//
//     constructor(plist: any) {
//         this.#plist = plist;
//     }
//
//     get(name: string): unknown | symbol {
//         const key = this.key(name);
//
//         if (this.#exists(key)) {
//             return this.value(key);
//         }
//
//         const metadataKey = this.metadataKey(name);
//
//         if (this.#exists(metadataKey)) {
//             return this.value(metadataKey);
//         }
//
//         return NO_DATA;
//     }
//
//     has(name: string): boolean {
//         return this.#exists(this.key(name)) || this.#exists(this.metadataKey(name));
//     }
//
//     key(name: string): number | symbol {
//         const keys = this.objects[1] as Record<string, { readonly CF$UID: number; }>;
//
//         if (name in keys) {
//             const key = keys[name]['CF$UID'];
//
//             if (key > 0) {
//                 return key;
//             }
//         }
//
//         return NO_DATA;
//     }
//
//     metadataKey(name: string): number | symbol {
//         const metadataKey = this.key('metadata');
//
//         if (!this.#exists(metadataKey)) {
//             return NO_DATA;
//         }
//
//         const metadata = this.value(metadataKey) as Record<string, { readonly CF$UID: number; }>;
//
//         if (name in metadata) {
//             const key = metadata[name]['CF$UID'];
//
//             if (key > 0) {
//                 return key;
//             }
//         }
//
//         return NO_DATA;
//     }
//
//     value(key: number): unknown | symbol {
//         if (key in this.objects) {
//             return this.objects[key];
//         }
//
//         return NO_DATA;
//     }
//
//     #exists(key: number | symbol): key is number {
//         return key !== NO_DATA;
//     }
// }
