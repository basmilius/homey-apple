export const ARTWORK_FADE_DURATION = 400;

const SOURCE_TIMEOUT = 2000;

export type ArtworkSources = readonly [local: string, source: string, cloud: string];

/**
 * Index of the source that last loaded successfully. Shared between instances, so a dashboard
 * outside the home network pays the timeout for the local url only once.
 */
let preferredSource = 0;

export class CrossfadeArtwork {
    readonly #container: HTMLElement;
    readonly #layers: readonly [HTMLImageElement, HTMLImageElement];
    #front = 0;
    #key = '';
    #revision = 0;

    constructor(container: HTMLElement, front: HTMLImageElement, back: HTMLImageElement) {
        this.#container = container;
        this.#layers = [front, back];
    }

    setLoading(loading: boolean): void {
        this.#container.classList.toggle('is-loading', loading);
    }

    update(sources: ArtworkSources): void {
        const key = sources.join('|');

        if (key === this.#key) {
            return;
        }

        this.#key = key;
        this.#revision++;

        if (!sources.some(Boolean)) {
            this.#clear();
            return;
        }

        void this.#load(sources, this.#revision);
    }

    async #load(sources: ArtworkSources, revision: number): Promise<void> {
        const incoming = this.#layers[this.#front ^ 1];
        const order = sourceOrder(sources);
        this.setLoading(true);

        for (const index of order) {
            const loaded = await this.#tryLoad(incoming, sources[index]!, index === order[order.length - 1]);

            if (revision !== this.#revision) {
                return;
            }

            if (loaded) {
                preferredSource = index;
                incoming.classList.add('is-visible');
                this.#layers[this.#front].classList.remove('is-visible');
                this.#front ^= 1;
                this.#container.classList.remove('empty');
                this.setLoading(false);

                return;
            }
        }

        this.#clear();
    }

    async #tryLoad(layer: HTMLImageElement, url: string, last: boolean): Promise<boolean> {
        layer.src = url;
        const decoded = layer.decode().then(() => true, () => false);

        if (last) {
            return decoded;
        }

        return Promise.race([decoded, timeout(SOURCE_TIMEOUT)]);
    }

    #clear(): void {
        for (const layer of this.#layers) {
            layer.classList.remove('is-visible');
        }

        this.#container.classList.add('empty');
        this.setLoading(false);
    }
}

function sourceOrder(sources: ArtworkSources): number[] {
    const indexes = [preferredSource, 0, 1, 2];

    return indexes.filter((index, position) => !!sources[index] && indexes.indexOf(index) === position);
}

function timeout(duration: number): Promise<boolean> {
    return new Promise(resolve => setTimeout(() => resolve(false), duration));
}
