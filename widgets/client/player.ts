import type { MiniPlayerState } from '../../src/logic/airplay';
import { type ArtworkSources, CrossfadeArtwork } from './artwork';
import { MotionArtwork } from './motionArtwork';

type HomeyWidget = {
    getSettings(): Record<string, boolean>;
    getDeviceIds(): string[];
    __(key: string): string;
    on(event: string, callback: (state: MiniPlayerState) => void): void;
    api(method: string, path: string, body?: object): Promise<MiniPlayerState | boolean | null>;
    hapticFeedback(): void;
    ready(options: {height: number}): void;
    setHeight(height: number): void;
};

declare global {
    interface Window {
        onHomeyReady(homey: HomeyWidget): void;
    }
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

function icon(path: string): string {
    return `<svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="${path}"/></svg>`;
}

const playIcon = icon('M7 4v16l14-8z');
const pauseIcon = icon('M6 4h4v16H6zm8 0h4v16h-4z');
const repeatIcon = icon('M17 2l5 5-5 5V9H6v4H3V8a2 2 0 0 1 2-2h12zM7 22l-5-5 5-5v3h11v-4h3v5a2 2 0 0 1-2 2H7z');

window.onHomeyReady = function (homey): void {
    const settings = homey.getSettings();
    const deviceId = homey.getDeviceIds()[0];
    const square = document.body.classList.contains('artwork-player');
    const artwork = new CrossfadeArtwork(element('artwork'), element('artwork-img'), element('artwork-img-back'));
    const background = element('background');
    const backgroundArtwork = new CrossfadeArtwork(background, element('background-img'), element('background-img-back'));
    const play = element<HTMLButtonElement>('btn-play');
    const previous = element<HTMLButtonElement>('btn-prev');
    const next = element<HTMLButtonElement>('btn-next');
    const shuffle = element<HTMLButtonElement>('btn-shuffle');
    const repeat = element<HTMLButtonElement>('btn-repeat');
    const volume = element<HTMLInputElement>('volume-slider');
    const motion = new MotionArtwork(element<HTMLVideoElement>('artwork-video'));
    let state: MiniPlayerState | null = null;
    let ready = false;
    let disposed = false;
    let revision = 0;
    let pending = false;

    background.hidden = square || !settings.show_blurred_artwork;
    element('controls').hidden = settings.show_controls === false;
    element('progress-container').hidden = settings.show_progress === false;
    element('volume-container').hidden = !settings.show_volume;
    repeat.innerHTML = repeatIcon;

    function updateHeight(): void {
        const height = Math.ceil(document.body.getBoundingClientRect().height);

        if (ready) {
            homey.setHeight(height);
        } else {
            homey.ready({height});
            ready = true;
        }
    }

    function tickProgress(): void {
        const duration = Math.max(0, state?.duration ?? 0);
        const elapsed = state?.playing ? Math.max(0, (Date.now() - state.positionTimestamp) / 1000) : 0;
        const position = Math.min(duration, Math.max(0, (state?.position ?? 0) + elapsed));
        element('progress-fill').style.setProperty('--progress', `${duration ? position / duration * 100 : 0}%`);
        element('progress-time').textContent = duration ? `${formatTime(position)} / ${formatTime(duration)}` : '';
        element('progress-container').setAttribute('aria-label', duration ? `${formatTime(position)} / ${formatTime(duration)}` : '');
    }

    function render(nextState: MiniPlayerState | null): void {
        state = nextState;
        element('track').textContent = state?.track || '—';
        element('meta').textContent = state ? [state.artist, state.album].filter(Boolean).join(' · ') || '—' : homey.__('widget.mini_player.no_device');
        const sources = artworkSources(state);
        artwork.update(sources);

        if (!background.hidden) {
            backgroundArtwork.update(sources);
        }

        motion.update(settings.show_animated_artwork === false ? null : state?.animatedArtworkUrl ?? null, !!state?.playing);
        play.innerHTML = state?.playing ? pauseIcon : playIcon;
        play.setAttribute('aria-label', label(state?.playing ? 'pause' : 'play'));
        previous.setAttribute('aria-label', label('previous'));
        next.setAttribute('aria-label', label('next'));
        shuffle.setAttribute('aria-label', label('shuffle'));
        repeat.setAttribute('aria-label', label('repeat'));
        volume.setAttribute('aria-label', label('volume'));
        play.disabled = !state || pending;
        previous.disabled = !state || pending || state.features.previous === false;
        next.disabled = !state || pending || state.features.next === false;
        shuffle.disabled = !state || pending;
        repeat.disabled = !state || pending;
        shuffle.hidden = square || !state?.features.shuffle;
        repeat.hidden = square || !state?.features.repeat;
        shuffle.classList.toggle('active', !!state?.shuffle);
        shuffle.setAttribute('aria-pressed', String(!!state?.shuffle));
        repeat.classList.toggle('active', !!state && state.repeat !== 'off');
        repeat.setAttribute('aria-pressed', String(!!state && state.repeat !== 'off'));
        repeat.dataset.mode = state?.repeat ?? 'off';
        element('volume-container').hidden = !settings.show_volume || state?.volume == null;

        if (document.activeElement !== volume) {
            volume.value = String(state?.volume ?? 0);
        }

        tickProgress();
        updateHeight();
    }

    function label(key: string): string {
        return homey.__(`widget.mini_player.${key}`);
    }

    async function refresh(clearStatus = true): Promise<void> {
        if (!deviceId || disposed) {
            return;
        }

        const started = revision;

        try {
            const result = await homey.api('GET', `/${encodeURIComponent(deviceId)}`);

            if (!disposed && started === revision) {
                if (clearStatus) {
                    element('status').textContent = '';
                }

                render(typeof result === 'object' ? result : null);
            }
        } catch {
            element('status').textContent = label('connection_error');
            artwork.setLoading(false);
        }
    }

    async function command(name: string, body?: object): Promise<void> {
        if (!deviceId || pending) {
            return;
        }

        pending = true;
        render(state);

        try {
            homey.hapticFeedback();
        } catch {
            // Haptics are unavailable in desktop dashboards.
        }

        try {
            const result = await homey.api('POST', `/${encodeURIComponent(deviceId)}/${name}`, body);
            element('status').textContent = result ? '' : label('command_error');
        } catch {
            element('status').textContent = label('command_error');
        } finally {
            pending = false;
            render(state);
            await refresh(false);
        }
    }

    previous.addEventListener('click', () => void command('previous'));
    next.addEventListener('click', () => void command('next'));
    play.addEventListener('click', () => void command('playing'));
    shuffle.addEventListener('click', () => void command('shuffle', {shuffle: !state?.shuffle}));
    repeat.addEventListener('click', () => void command('repeat', {repeat: state?.repeat === 'off' ? 'all' : state?.repeat === 'all' ? 'one' : 'off'}));
    volume.addEventListener('change', () => void command('volume', {volume: Number(volume.value)}));

    homey.on('apple-mini-player-update', update => {
        if (!disposed && update?.deviceId === deviceId) {
            revision++;
            render(update);
        }
    });

    const resize = new ResizeObserver(updateHeight);
    resize.observe(document.body);

    const progressTimer = setInterval(() => {
        if (!document.hidden) {
            tickProgress();
        }
    }, 1000);

    const refreshTimer = setInterval(() => {
        if (!document.hidden) {
            void refresh();
        }
    }, 60_000);

    const visibility = (): void => {
        if (!document.hidden) {
            void refresh();
        }
    };

    document.addEventListener('visibilitychange', visibility);

    window.addEventListener('pagehide', () => {
        disposed = true;
        clearInterval(progressTimer);
        clearInterval(refreshTimer);
        resize.disconnect();
        motion.dispose();
        document.removeEventListener('visibilitychange', visibility);
    }, {once: true});

    render(null);
    artwork.setLoading(!!deviceId);
    void refresh();
};

function artworkSources(state: MiniPlayerState | null): ArtworkSources {
    return [state?.artworkLocalUrl ?? '', state?.artworkSourceUrl ?? '', state?.artworkUrl ?? ''];
}

function formatTime(totalSeconds: number): string {
    const seconds = Math.floor(totalSeconds);
    const minutes = Math.floor(seconds / 60);

    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
