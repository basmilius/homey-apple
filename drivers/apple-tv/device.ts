import { writeFile } from 'node:fs/promises';
// @ts-ignore
import { CompanionLink, parseBinaryPlist } from '@basmilius/apple-companion-link';
import Homey, { DiscoveryResultMDNSSD, Image } from 'homey';
import { capabilities } from './driver.compose.json';

const NO_DATA = Symbol();

module.exports = class AppleTVDevice extends Homey.Device {

    private artwork!: Image;
    private artworkPath!: string;
    public protocol!: CompanionLink;

    async onInit() {
        const settings = this.getSettings();
        const store = this.getStore();

        this.log('AppleTV device is initializing...', {settings, store});

        await this.updateCapabilities();

        this.artworkPath = `/userdata/${store.id}.png`;

        const [address, port] = await this.discover(store.id);

        await this.setupProtocol(address, port);
        await this.pairVerify(store.credentials);

        await this.registerNowPlaying();
        await this.registerOnOff();
        await this.registerRemote();
        await this.registerVolume();

        await this.protocol.api._unsubscribe('_iMC');

        this.log('AppleTV is connected!');
    }

    async onUninit(): Promise<void> {
        await this.artwork.unregister();
        await this.protocol?.disconnect();
        this.protocol = undefined;
    }

    async onAdded() {
        this.log('AppleTV has been added');
    }

    async onSettings({oldSettings, newSettings, changedKeys}: any): Promise<string | void> {
        this.log('AppleTV settings where changed');
    }

    async onRenamed(name: string) {
        this.log('AppleTV was renamed');
    }

    async onDeleted() {
        this.log('AppleTV has been deleted');
    }

    async discover(id: string): Promise<[string, number]> {
        const discovery = this.homey.discovery.getStrategy('companion-link');

        return new Promise((resolve, reject) => {
            const discoveryResult: DiscoveryResultMDNSSD = discovery.getDiscoveryResult(id) as DiscoveryResultMDNSSD;

            if (discoveryResult) {
                resolve([discoveryResult.address, Number(discoveryResult.port)]);
                return;
            }

            discovery.on('result', result => {
                if (result.id !== id) {
                    return;
                }

                resolve([result.address, Number(result.port)]);
            });
        });
    }

    async pairVerify(credentials: Record<string, string>): Promise<void> {
        const keys = await this.protocol.verify.start({
            accessoryIdentifier: credentials.accessoryIdentifier,
            accessoryLongTermPublicKey: Buffer.from(credentials.accessoryLongTermPublicKey, 'hex'),
            pairingId: Buffer.from(credentials.pairingId, 'hex'),
            publicKey: Buffer.from(credentials.publicKey, 'hex'),
            secretKey: Buffer.from(credentials.secretKey, 'hex')
        });

        await this.protocol.socket.enableEncryption(
            keys.accessoryToControllerKey,
            keys.controllerToAccessoryKey
        );

        await this.protocol.api._systemInfo(credentials.pairingId);
        await this.protocol.api._touchStart();
        await this.protocol.api._sessionStart();
        await this.protocol.api._tvrcSessionStart();
    }

    async setupProtocol(address: string, port: number): Promise<void> {
        this.protocol = new CompanionLink({
            address,
            service: {port}
        });

        await this.protocol.connect();
    }

    async registerNowPlaying(): Promise<void> {
        this.registerCapabilityListener('speaker_playing', async (value: boolean) => {
            if (value) {
                await this.protocol.api.mediaControlCommand('Play');
            } else {
                await this.protocol.api.mediaControlCommand('Pause');
            }
        });

        this.registerCapabilityListener('speaker_next', async () => {
            await this.protocol.api.mediaControlCommand('NextTrack');
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.protocol.api.mediaControlCommand('PreviousTrack');
        });

        await this.protocol.api._subscribe('NowPlayingInfo', async (evt: CustomEvent) => {
            try {
                const {detail: {NowPlayingInfoKey}} = evt;
                const buffer = NowPlayingInfoKey.buffer.slice(
                    NowPlayingInfoKey.byteOffset,
                    NowPlayingInfoKey.byteOffset + NowPlayingInfoKey.byteLength
                );

                const nowPlaying = new NowPlayingInfo(parseBinaryPlist(buffer));

                if (!nowPlaying.valid) {
                    return;
                }

                if (nowPlaying.has('playbackState')) {
                    await this.setCapabilityValue('speaker_playing', nowPlaying.get('playbackState') === 1);
                }

                if (nowPlaying.has('duration')) {
                    await this.setCapabilityValue('speaker_duration', nowPlaying.get('duration'));
                }

                if (nowPlaying.has('title')) {
                    await this.setCapabilityValue('speaker_track', nowPlaying.get('title'));
                }

                if (nowPlaying.has('imageData') && nowPlaying.has('imageDataIsPlaceholder')) {
                    const imageData = nowPlaying.get('imageData') as Buffer;
                    const imageDataIsPlaceholder = nowPlaying.get('imageDataIsPlaceholder');

                    if (!imageDataIsPlaceholder) {
                        this.artwork?.unregister();
                        this.artwork = await this.homey.images.createImage();
                        this.artwork.setPath(this.artworkPath);

                        await writeFile(this.artworkPath, Buffer.from(imageData));

                        await this.artwork.update();
                        await this.setAlbumArtImage(this.artwork);
                        await this.artwork.update();
                    }
                }
            } catch (err) {
                this.error(err);
            }
        });

        await this.protocol.api.fetchNowPlayingInfo();
    }

    async registerOnOff(): Promise<void> {
        const state = await this.protocol.api.getAttentionState();

        this.registerCapabilityListener('onoff', async (value: boolean) => {
            if (value) {
                await this.protocol.api.pressButton('Wake');
            } else {
                await this.protocol.api.pressButton('Sleep');
            }
        });

        await this.setCapabilityValue('onoff', state === 'awake' || state === 'screensaver');

        await this.protocol.api._subscribe('TVSystemStatus', (evt: CustomEvent) => {
            const {state} = evt.detail;

            this.setCapabilityValue('onoff', state === 0x02 || state === 0x03);
        });
    }

    async registerRemote(): Promise<void> {
        const keys = capabilities.filter(k => k.startsWith('remote_'));

        this.registerMultipleCapabilityListener(keys, async values => {
            values.remote_up === true && await this.protocol.api.pressButton('Up');
            values.remote_down === true && await this.protocol.api.pressButton('Down');
            values.remote_left === true && await this.protocol.api.pressButton('Left');
            values.remote_right === true && await this.protocol.api.pressButton('Right');
            values.remote_select === true && await this.protocol.api.pressButton('Select');
            values.remote_home === true && await this.protocol.api.pressButton('Home');
            values.remote_back === true && await this.protocol.api.pressButton('Menu');
            values.remote_playpause === true && await this.protocol.api.pressButton('PlayPause');
            values.remote_siri === true && await this.protocol.api.pressButton('Siri', 'Hold', 1000);
        }, 0);
    }

    async registerVolume(): Promise<void> {
        this.registerCapabilityListener('volume_down', async () => {
            await this.protocol.api.pressButton('VolumeDown');
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.protocol.api.pressButton('VolumeUp');
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.protocol.api.pressButton('PageUp');
        });
    }

    async updateCapabilities(): Promise<void> {
        const currentCapabilities = this.getCapabilities();
        const availableCapabilities = capabilities;

        for (const capability of availableCapabilities) {
            if (currentCapabilities.includes(capability)) {
                continue;
            }

            await this.addCapability(capability);
        }

        for (const capability of currentCapabilities) {
            if (availableCapabilities.includes(capability)) {
                continue;
            }

            await this.removeCapability(capability);
        }
    }
};

class NowPlayingInfo {
    get objects(): Record<number, unknown> {
        return this.#plist.$objects;
    }

    get valid(): boolean {
        return this.#plist && this.#plist.$objects && this.#plist.$objects[1];
    }

    readonly #plist: any;

    constructor(plist: any) {
        this.#plist = plist;
    }

    get(name: string): unknown | symbol {
        const key = this.key(name);

        if (this.#exists(key)) {
            return this.value(key);
        }

        const metadataKey = this.metadataKey(name);

        if (this.#exists(metadataKey)) {
            return this.value(metadataKey);
        }

        return NO_DATA;
    }

    has(name: string): boolean {
        return this.#exists(this.key(name)) || this.#exists(this.metadataKey(name));
    }

    key(name: string): number | symbol {
        const keys = this.objects[1] as Record<string, { readonly CF$UID: number; }>;

        if (name in keys) {
            const key = keys[name]['CF$UID'];

            if (key > 0) {
                return key;
            }
        }

        return NO_DATA;
    }

    metadataKey(name: string): number | symbol {
        const metadataKey = this.key('metadata');

        if (!this.#exists(metadataKey)) {
            return NO_DATA;
        }

        const metadata = this.value(metadataKey) as Record<string, { readonly CF$UID: number; }>;

        if (name in metadata) {
            const key = metadata[name]['CF$UID'];

            if (key > 0) {
                return key;
            }
        }

        return NO_DATA;
    }

    value(key: number): unknown | symbol {
        if (key in this.objects) {
            return this.objects[key];
        }

        return NO_DATA;
    }

    #exists(key: number | symbol): key is number {
        return key !== NO_DATA;
    }
}
