import { AirPlay, Proto } from '@basmilius/apple-airplay';
import Homey, { type DiscoveryResultMDNSSD } from 'homey';

const CAPABILITIES = [
    'speaker_album',
    'speaker_artist',
    'speaker_duration',
    'speaker_next',
    'speaker_playing',
    'speaker_position',
    'speaker_prev',
    'speaker_stop',
    'speaker_track',
    'volume_down',
    'volume_mute',
    'volume_set',
    'volume_up'
];

export default class HomePodMiniDevice extends Homey.Device {
    #artwork?: Homey.Image;
    #airplay!: AirPlay;
    #feedbackInterval!: NodeJS.Timeout;
    #lastPlaybackStateTimestamp: number = 0;

    async onInit(): Promise<void> {
        try {
            await this.#updateCapabilities();
            await this.#connect();
            await this.#registerCapabilities();

            this.log(`HomePodMiniDevice ${this.getName()} has been initialized.`);
        } catch (err) {
            this.error(err);
            await this.setUnavailable((err as Error).message);
        }
    }

    async onUninit(): Promise<void> {
        await this.#airplay?.disconnect();
        this.homey.clearInterval(this.#feedbackInterval);

        this.log('HomePodMiniDevice has been uninitialized.');
    }

    async #connect(): Promise<void> {
        const device = await this.#discover();

        this.#airplay = new AirPlay({
            address: device.address,
            service: {
                port: device.port
            }
        });

        await this.#airplay.connect();
        await this.#airplay.pairing.start();
        const keys = await this.#airplay.pairing.transient();

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

    async #discover(): Promise<DiscoveryResultMDNSSD> {
        const strategy = this.homey.discovery.getStrategy('homepod-mini');
        const result = strategy.getDiscoveryResult(this.getStore().id);

        return result as DiscoveryResultMDNSSD;
    }

    async #registerCapabilities(): Promise<void> {
        this.registerCapabilityListener('speaker_next', async () => {
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendCommand(Proto.Command.NextInContext));
        });

        this.registerCapabilityListener('speaker_prev', async () => {
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendCommand(Proto.Command.PreviousInContext));
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
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendButtonEvent(12, 0xE9, true));
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendButtonEvent(12, 0xE9, false));
        });

        this.registerCapabilityListener('volume_down', async () => {
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendButtonEvent(12, 0xEA, true));
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendButtonEvent(12, 0xEA, false));
        });

        this.registerCapabilityListener('volume_mute', async () => {
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendButtonEvent(12, 0xE2, true));
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.sendButtonEvent(12, 0xE2, false));
        });

        this.registerCapabilityListener('volume_set', async (volume: number) => {
            await this.#airplay.dataStream!.exchange(this.#airplay.dataStream!.messages.setVolume(volume));
        });
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
