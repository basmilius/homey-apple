import type { RepeatMode } from '@apple-protocols/devices';

const REPEAT_MODES: readonly RepeatMode[] = ['off', 'one', 'all'];

/**
 * Maps Homey speaker_repeat capability values to repeat modes.
 */
export const capabilityToRepeatMode: Record<string, RepeatMode> = {
    none: 'off',
    track: 'one',
    playlist: 'all'
};

/**
 * Maps repeat modes to Homey capability values.
 */
export const repeatModeToCapability: Record<string, string> = {
    off: 'none',
    one: 'track',
    all: 'playlist'
};

/**
 * Reads a repeat mode from a flow argument; anything unknown is off.
 */
export function toRepeatMode(value: string): RepeatMode {
    return REPEAT_MODES.find(mode => mode === value) ?? 'off';
}
