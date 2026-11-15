type CacheEntry = {
    expires: number;
    result: Promise<string | null>;
};

export class AnimatedArtworkCache {
    readonly #entries = new Map<string, CacheEntry>();

    async get(key: string, load: () => Promise<string | null>, now = Date.now()): Promise<string | null> {
        const cached = this.#entries.get(key);

        if (cached && cached.expires > now) {
            return cached.result;
        }

        const entry: CacheEntry = {
            expires: now + 15 * 60_000,
            result: Promise.resolve().then(load)
        };

        this.#entries.delete(key);
        this.#entries.set(key, entry);

        if (this.#entries.size > 32) {
            this.#entries.delete(this.#entries.keys().next().value!);
        }

        try {
            const url = await entry.result;

            if (!url) {
                entry.expires = now + 60_000;
            }

            return url;
        } catch (error) {
            if (this.#entries.get(key) === entry) {
                this.#entries.delete(key);
            }

            throw error;
        }
    }
}
