import Hls from 'hls.js';
import { ARTWORK_FADE_DURATION } from './artwork';

// Tearing the stream down also fires an error, so a url is only given up on after repeated failures.
const MAX_FAILURES = 3;

export class MotionArtwork {
    readonly #video: HTMLVideoElement;
    readonly #reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    readonly #observer: IntersectionObserver;
    #hls?: Hls;
    #url: string | null = null;
    #loadedUrl: string | null = null;
    #failedUrl: string | null = null;
    #failures = 0;
    #fadeTimer?: ReturnType<typeof setTimeout>;
    #visible = true;
    #playing = false;

    constructor(video: HTMLVideoElement) {
        this.#video = video;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;

        video.addEventListener('playing', () => {
            video.classList.add('is-playing');
            this.#failures = 0;
        });

        video.addEventListener('error', this.#fail);
        document.addEventListener('visibilitychange', this.#sync);
        this.#reducedMotion.addEventListener('change', this.#sync);

        this.#observer = new IntersectionObserver(entries => {
            this.#visible = entries[entries.length - 1]?.isIntersecting ?? false;
            this.#sync();
        });

        this.#observer.observe(video.parentElement!);
    }

    update(url: string | null, playing: boolean): void {
        this.#playing = playing;

        if (url !== this.#url) {
            this.#failedUrl = null;
            this.#failures = 0;
            this.#url = url;
            this.#switchSource();
            return;
        }

        this.#sync();
    }

    dispose(): void {
        this.#observer.disconnect();
        document.removeEventListener('visibilitychange', this.#sync);
        this.#reducedMotion.removeEventListener('change', this.#sync);
        this.#video.removeEventListener('error', this.#fail);
        this.#destroy();
    }

    readonly #sync = (): void => {
        if (this.#fadeTimer) {
            return;
        }

        if (document.hidden || !this.#visible || this.#reducedMotion.matches) {
            this.#destroy();
            return;
        }

        if (!this.#playing || !this.#url || this.#exhausted()) {
            this.#video.pause();
            return;
        }

        if (this.#loadedUrl === this.#url) {
            this.#play();
            return;
        }

        this.#loadedUrl = this.#url;

        if (Hls.isSupported()) {
            const hls = new Hls({capLevelToPlayerSize: true, maxBufferLength: 15, maxMaxBufferLength: 30, enableWorker: false});
            this.#hls = hls;

            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (data.fatal) {
                    this.#fail();
                }
            });

            hls.loadSource(this.#url);
            hls.attachMedia(this.#video);
        } else if (this.#video.canPlayType('application/vnd.apple.mpegurl')) {
            this.#video.src = this.#url;
        } else {
            this.#fail();
            return;
        }

        this.#play();
    };

    #play(): void {
        void this.#video.play().catch(() => this.#video.classList.remove('is-playing'));
    }

    readonly #fail = (): void => {
        const url = this.#loadedUrl ?? this.#url;

        if (url !== this.#failedUrl) {
            this.#failedUrl = url;
            this.#failures = 0;
        }

        this.#failures++;
        this.#destroy();
    };

    #exhausted(): boolean {
        return this.#url === this.#failedUrl && this.#failures >= MAX_FAILURES;
    }

    /**
     * Moves to the artwork in #url. A visible stream first fades out, so the still artwork
     * underneath can crossfade in before the stream is torn down.
     */
    #switchSource(): void {
        clearTimeout(this.#fadeTimer);
        this.#fadeTimer = undefined;

        // The now playing state drops the animated artwork whenever the album metadata is
        // briefly incomplete, so keep the stream we already have when it comes back.
        if (this.#url && this.#url === this.#loadedUrl) {
            this.#sync();
            return;
        }

        if (!this.#video.classList.contains('is-playing')) {
            this.#destroy();
            this.#sync();
            return;
        }

        this.#video.classList.remove('is-playing');
        this.#video.pause();

        this.#fadeTimer = setTimeout(() => {
            this.#fadeTimer = undefined;
            this.#destroy();
            this.#sync();
        }, ARTWORK_FADE_DURATION);
    }

    #destroy(): void {
        clearTimeout(this.#fadeTimer);
        this.#fadeTimer = undefined;
        this.#video.classList.remove('is-playing');
        this.#video.pause();
        this.#hls?.destroy();
        this.#hls = undefined;

        if (this.#loadedUrl) {
            this.#video.removeAttribute('src');
            this.#video.load();
        }

        this.#loadedUrl = null;
    }
}
