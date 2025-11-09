import { PassThrough } from 'node:stream';
import { Proto } from '@basmilius/apple-airplay';
// @ts-ignore
import { type AccessoryCredentials, waitFor } from '@basmilius/apple-common';
// @ts-ignore
import { AppleTV } from '@basmilius/apple-devices';
import Homey, { type DiscoveryResultMDNSSD } from 'homey';

const CAPABILITIES = [
    'speaker_album',
    'speaker_artist',
    'speaker_duration',
    'speaker_next',
    'speaker_playing',
    'speaker_position',
    'speaker_prev',
    'speaker_track',
    'onoff',
    'volume_down',
    'volume_mute',
    'volume_up',
    'remote_up',
    'remote_down',
    'remote_left',
    'remote_right',
    'remote_select',
    'remote_home',
    'remote_back',
    'remote_playpause',
    'remote_siri'
];

export default class AppleTVDevice extends Homey.Device {
    get appletv(): AppleTV {
        return this.#appletv;
    }

    #appletv!: AppleTV;
    #artwork!: Homey.Image;
    #artworkURL?: string;
    #contentIdentifier?: string;

    async onInit(): Promise<void> {
        this.#artwork = await this.homey.images.createImage();

        try {
            await this.#updateCapabilities();
            await this.#connect();
            await this.#registerCapabilities();

            await this.setAlbumArtImage(this.#artwork);

            this.log(`AppleTVDevice ${this.getName()} has been initialized.`);
        } catch (err) {
            this.error(err);
            await this.setUnavailable((err as Error).message);
        }
    }

    async onUninit(): Promise<void> {
        await this.#appletv?.disconnect();

        this.log('AppleTVDevice has been uninitialized.');
    }

    async #connect(): Promise<void> {
        const [airplay, companionLink] = await this.#discover();

        this.#appletv = new AppleTV(
            {
                address: airplay.address,
                service: {
                    port: airplay.port
                },
                packet: {
                    additionals: [{
                        rdata: airplay.txt
                    }]
                }
            },
            {
                address: companionLink.address,
                service: {
                    port: companionLink.port
                }
            }
        );

        try {
            this.#appletv.airplay.state.on('setState', async () => await this.#onSetState());
            this.#appletv.airplay.state.on('setArtwork', async (message: any) => console.log(message));
            this.#appletv.airplay.state.on('updateContentItemArtwork', async (message: any) => console.log(message));

            this.#appletv.on('disconnected', async (unexpected: boolean) => {
                if (!unexpected) {
                    return;
                }

                this.log('Disconnected from Apple TV, reconnecting...');

                this.#appletv = undefined;
                await waitFor(1000);
                await this.#connect();
            });

            await this.#appletv.connect(await this.#credentials());
        } catch (err) {
            this.error(err);
            await this.setUnavailable((err as Error).message);
            return;
        }
    }

    async #credentials(): Promise<AccessoryCredentials> {
        const credentials = this.getStore().credentials;

        return {
            accessoryIdentifier: credentials.accessoryIdentifier,
            accessoryLongTermPublicKey: Buffer.from(credentials.accessoryLongTermPublicKey, 'hex'),
            pairingId: Buffer.from(credentials.pairingId, 'hex'),
            publicKey: Buffer.from(credentials.publicKey, 'hex'),
            secretKey: Buffer.from(credentials.secretKey, 'hex')
        };
    }

    async #discover(): Promise<[DiscoveryResultMDNSSD, DiscoveryResultMDNSSD]> {
        const airplayStrategy = this.homey.discovery.getStrategy('appletv-airplay');
        const companionLinkStrategy = this.homey.discovery.getStrategy('appletv-companion-link');

        const airplayResult = airplayStrategy.getDiscoveryResult(this.getStore().id);
        const companionLinkResult = companionLinkStrategy.getDiscoveryResult(this.getStore().id);

        return [
            airplayResult as DiscoveryResultMDNSSD,
            companionLinkResult as DiscoveryResultMDNSSD
        ];
    }

    async #registerCapabilities(): Promise<void> {
        await this.#registerOnOff();
        await this.#registerRemote();

        this.registerCapabilityListener('speaker_next', async () => {
            await this.#appletv.next();
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#appletv.previous();
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#appletv.stop();
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.#appletv.play();
            } else {
                await this.#appletv.pause();
            }
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.#appletv.volumeUp();
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.#appletv.volumeDown();
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.#appletv.volumeMute();
        });
    }

    async #registerOnOff(): Promise<void> {
        const state = await this.#appletv.companionLink.getAttentionState();

        this.registerCapabilityListener('onoff', async (value: boolean) => {
            if (value) {
                await this.#appletv.turnOn();
            } else {
                await this.#appletv.turnOff();
            }
        });

        await this.setCapabilityValue('onoff', state === 'awake' || state === 'screensaver');

        this.#appletv.companionLink.on('power', (on: boolean) => {
            this.setCapabilityValue('onoff', on);
        });
    }

    async #registerRemote(): Promise<void> {
        const keys = CAPABILITIES.filter(k => k.startsWith('remote_'));

        this.registerMultipleCapabilityListener(keys, async values => {
            values.remote_up === true && await this.#appletv.companionLink.pressButton('Up');
            values.remote_down === true && await this.#appletv.companionLink.pressButton('Down');
            values.remote_left === true && await this.#appletv.companionLink.pressButton('Left');
            values.remote_right === true && await this.#appletv.companionLink.pressButton('Right');
            values.remote_select === true && await this.#appletv.companionLink.pressButton('Select');
            values.remote_home === true && await this.#appletv.companionLink.pressButton('Home');
            values.remote_back === true && await this.#appletv.companionLink.pressButton('Menu');
            values.remote_playpause === true && await this.#appletv.companionLink.pressButton('PlayPause');
            values.remote_siri === true && await this.#appletv.companionLink.pressButton('Siri', 'Hold', 1000);
        }, 0);
    }

    async #onSetState(): Promise<void> {
        if (!this.#appletv) {
            return;
        }

        await this.setCapabilityValue('speaker_playing', this.#appletv.playbackState === Proto.PlaybackState_Enum.Playing);

        const item = this.#appletv.playbackQueue?.contentItems?.[0] ?? null;

        if (!item) {
            // todo(Bas): Figure out if we want to clear capabilities here.
            return;
        }

        this.#contentIdentifier = item.identifier;

        await this.setCapabilityValue('speaker_album', item.metadata.albumName);
        await this.setCapabilityValue('speaker_artist', item.metadata.trackArtistName || this.#appletv.airplay.state.nowPlayingClient?.displayName || '-');
        await this.setCapabilityValue('speaker_track', item.metadata.title);
        await this.setCapabilityValue('speaker_duration', item.metadata.duration);
        await this.setCapabilityValue('speaker_position', item.metadata.elapsedTime);

        if (item.metadata.artworkAvailable) {
            if (item.metadata.artworkURL) {
                await this.#updateArtwork(item.metadata.artworkURL);
            } else if (item.artworkData?.byteLength > 0) {
                this.log('Artwork is available in playback queue, but not yet loaded. Updating it from the playback queue.');
                await this.#updateArtworkBuffer(item.artworkData);
            } else if (this.#artworkURL !== this.#contentIdentifier) {
                this.log('Artwork is not yet available, requesting it through playback queue.');
                this.#artworkURL = this.#contentIdentifier;
                await this.#appletv.airplay.requestPlaybackQueue(1);
            }
        } else {
            await this.#updateArtwork(null);
        }
    }

    async #updateArtwork(url: string | null): Promise<void> {
        if (url) {
            if (this.#artworkURL !== url) {
                this.#artworkURL = url;
                this.#artwork.setUrl(url);
                await this.#artwork.update();
            }
        } else {
            // todo(Bas): clear artwork.
        }
    }

    async #updateArtworkBuffer(buffer: Buffer): Promise<void> {
        this.#artwork.setStream((stream: any) => {
            const pt = new PassThrough();
            pt.end(buffer);
            pt.pipe(stream);
        });
        await this.#artwork.update();
    }

    async #updateCapabilities(): Promise<void> {
        const currentCapabilities = this.getCapabilities();

        for (const capability of CAPABILITIES) {
            if (currentCapabilities.includes(capability)) {
                continue;
            }

            await this.addCapability(capability);
        }

        for (const capability of currentCapabilities) {
            if (CAPABILITIES.includes(capability)) {
                continue;
            }

            await this.removeCapability(capability);
        }
    }
}
