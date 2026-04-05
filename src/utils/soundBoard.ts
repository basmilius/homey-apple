import type Homey from 'homey/lib/Homey';

const SOUNDBOARD_APP_ID = 'com.athom.soundboard';

export interface SoundBoardSound {
    readonly name: string;
    readonly path: string;
}

/**
 * Utility class for interacting with the Homey Soundboard app API.
 * Provides methods to retrieve available sounds and construct playback URLs.
 */
export default class SoundBoard {
    readonly #homey: Homey;

    constructor(homey: Homey) {
        this.#homey = homey;
    }

    /**
     * Retrieves all available sounds from the Soundboard app.
     *
     * @throws Error if the Soundboard app is not installed.
     */
    async getSounds(): Promise<SoundBoardSound[]> {
        const app = this.#homey.api.getApiApp(SOUNDBOARD_APP_ID);

        if (!await app.getInstalled()) {
            throw new Error(this.#homey.__('soundboard_not_installed'));
        }

        return app.get('/');
    }

    /**
     * Constructs a local HTTP URL for the given Soundboard sound.
     *
     * @param sound - The sound to construct the URL for.
     */
    async getSoundUrl(sound: SoundBoardSound): Promise<string> {
        const localAddress = await this.#homey.cloud.getLocalAddress();

        return `http://${localAddress}/app/${SOUNDBOARD_APP_ID}/${sound.path}`.replace(/\.\//g, '');
    }
}
