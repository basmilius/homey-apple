import { AirPlay, Proto } from '@basmilius/apple-airplay';
import type { AccessoryCredentials } from '@basmilius/apple-common';
import { CompanionLink } from '@basmilius/apple-companion-link';
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
    #artwork?: Homey.Image;
    #airplay!: AirPlay;
    #companionLink!: CompanionLink;
    #feedbackInterval!: NodeJS.Timeout;

    async onInit(): Promise<void> {
        try {
            await this.#updateCapabilities();
            await this.#connect();
            await this.#registerCapabilities();

            this.log(`AppleTVDevice ${this.getName()} has been initialized.`);
        } catch (err) {
            this.error(err);
            await this.setUnavailable((err as Error).message);
        }
    }

    async onUninit(): Promise<void> {
        await this.#airplay?.disconnect();
        this.homey.clearInterval(this.#feedbackInterval);

        this.log('AppleTVDevice has been uninitialized.');
    }

    async #connect(): Promise<void> {
        const [airplay, companionLink] = await this.#discover();

        await this.#connectAirPlay(airplay);
        await this.#connectCompanionLink(companionLink);
    }

    async #connectAirPlay(device: DiscoveryResultMDNSSD): Promise<void> {
        this.#airplay = new AirPlay({
            address: device.address,
            service: {
                port: device.port
            }
        });

        await this.#airplay.connect();

        const credentials = await this.#credentials();
        const keys = await this.#airplay.verify.start(credentials);

        await this.#airplay.rtsp.enableEncryption(
            keys.accessoryToControllerKey,
            keys.controllerToAccessoryKey
        );

        await this.#airplay.setupEventStream(keys.pairingId, keys.sharedSecret);
        await this.#airplay.setupDataStream(keys.sharedSecret);

        // this.#feedbackInterval = this.homey.setInterval(() => this.#airplay.feedback(), 2000);

        await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.deviceInfo(keys.pairingId));

        this.#airplay.dataStream!.on('deviceInfo', async () => {
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.setConnectionState());
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.clientUpdatesConfig());
        });

        this.#airplay.dataStream!.on('setState', this.#onSetState.bind(this));
        this.#airplay.dataStream!.on('updateContentItem', this.#onUpdateContentItem.bind(this));
        this.#airplay.dataStream!.on('updateContentItemArtwork', this.#onUpdateContentItemArtwork.bind(this));
        this.#airplay.dataStream!.on('volumeDidChange', this.#onVolumeDidChange.bind(this));
    }

    async #connectCompanionLink(device: DiscoveryResultMDNSSD): Promise<void> {
        this.#companionLink = new CompanionLink({
            address: device.address,
            service: {
                port: device.port
            }
        });

        await this.#companionLink.connect();

        const credentials = await this.#credentials();
        const keys = await this.#companionLink.verify.start(credentials);

        await this.#companionLink.socket.enableEncryption(
            keys.accessoryToControllerKey,
            keys.controllerToAccessoryKey
        );

        await this.#companionLink.api._systemInfo(credentials.pairingId);
        await this.#companionLink.api._touchStart();
        await this.#companionLink.api._sessionStart();
        await this.#companionLink.api._tvrcSessionStart();
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
            await this.#companionLink.api.mediaControlCommand('NextTrack');
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#companionLink.api.mediaControlCommand('PreviousTrack');
        });

        this.registerCapabilityListener('speaker_stop', async () => {
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendCommand(Proto.Command.Stop));
        });

        this.registerCapabilityListener('speaker_playing', async (play: boolean) => {
            if (play) {
                await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendCommand(Proto.Command.Play));
            } else {
                await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendCommand(Proto.Command.Pause));
            }
        });

        this.registerCapabilityListener('volume_up', async () => {
            await this.#companionLink.api.pressButton('VolumeUp');
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.#companionLink.api.pressButton('VolumeDown');
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.#companionLink.api.pressButton('PageUp');
        });
    }

    async #registerOnOff(): Promise<void> {
        const state = await this.#companionLink.api.getAttentionState();

        this.registerCapabilityListener('onoff', async (value: boolean) => {
            if (value) {
                await this.#companionLink.api.pressButton('Wake');
            } else {
                await this.#companionLink.api.pressButton('Sleep');
            }
        });

        await this.setCapabilityValue('onoff', state === 'awake' || state === 'screensaver');

        await this.#companionLink.api._subscribe('TVSystemStatus', (state: number) => {
            this.setCapabilityValue('onoff', state === 0x02 || state === 0x03);
        });
    }

    async #registerRemote(): Promise<void> {
        const keys = CAPABILITIES.filter(k => k.startsWith('remote_'));

        this.registerMultipleCapabilityListener(keys, async values => {
            values.remote_up === true && await this.#companionLink.api.pressButton('Up');
            values.remote_down === true && await this.#companionLink.api.pressButton('Down');
            values.remote_left === true && await this.#companionLink.api.pressButton('Left');
            values.remote_right === true && await this.#companionLink.api.pressButton('Right');
            values.remote_select === true && await this.#companionLink.api.pressButton('Select');
            values.remote_home === true && await this.#companionLink.api.pressButton('Home');
            values.remote_back === true && await this.#companionLink.api.pressButton('Menu');
            values.remote_playpause === true && await this.#companionLink.api.pressButton('PlayPause');
            values.remote_siri === true && await this.#companionLink.api.pressButton('Siri', 'Hold', 1000);
        }, 0);
    }

    async #onSetState(message: Proto.SetStateMessage): Promise<void> {
        const contentItem = message.playbackQueue?.contentItems?.[0];
        const metadata = contentItem?.metadata;

        if (message.playbackState !== Proto.PlaybackState_Enum.Unknown) {
            await this.setCapabilityValue('speaker_playing', message.playbackState === Proto.PlaybackState_Enum.Playing);
        }

        this.log(metadata);
        this.log(`playbackState = ${message.playbackState}; playbackStateTimestamp = ${message.playbackStateTimestamp}`);

        if (!metadata) {
            return;
        }

        this.#artwork?.unregister();
        this.#artwork = undefined;

        await this.setCapabilityValue('speaker_album', metadata.albumName);
        await this.setCapabilityValue('speaker_artist', metadata.trackArtistName);
        await this.setCapabilityValue('speaker_track', metadata.title);
        await this.setCapabilityValue('speaker_duration', metadata.duration);
        await this.setCapabilityValue('speaker_position', metadata.elapsedTime);

        if (metadata.artworkAvailable && metadata.artworkURL) {
            this.#artwork = await this.homey.images.createImage();
            this.#artwork!.setUrl(metadata.artworkURL);
            await this.setAlbumArtImage(this.#artwork);
            await this.#artwork?.update();
            this.homey.setTimeout(() => this.#artwork?.update(), 1000);
        }
    }

    async #onUpdateContentItem(message: Proto.UpdateContentItemMessage): Promise<void> {
        this.log('update content item', message.contentItems[0]);
    }

    async #onUpdateContentItemArtwork(message: Proto.UpdateContentItemArtworkMessage): Promise<void> {
        this.log('update content item artwork', message);
    }

    async #onVolumeDidChange(message: Proto.VolumeDidChangeMessage): Promise<void> {
        this.log(`Volume changed to ${message.volume}`);
        await this.setCapabilityValue('volume_set', message.volume);
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
