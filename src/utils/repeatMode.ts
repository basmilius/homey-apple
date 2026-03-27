import { Proto } from '@basmilius/apple-sdk';

/**
 * Maps Homey speaker_repeat capability values to Proto repeat mode enums.
 */
export const capabilityToRepeatMode: Record<string, Proto.RepeatMode_Enum> = {
    none: Proto.RepeatMode_Enum.Off,
    track: Proto.RepeatMode_Enum.One,
    playlist: Proto.RepeatMode_Enum.All
};

/**
 * Maps internal repeat mode strings to Proto repeat mode enums.
 */
export const repeatModeToProto: Record<string, Proto.RepeatMode_Enum> = {
    off: Proto.RepeatMode_Enum.Off,
    one: Proto.RepeatMode_Enum.One,
    all: Proto.RepeatMode_Enum.All
};

/**
 * Maps internal repeat mode strings to Homey capability values.
 */
export const repeatModeToCapability: Record<string, string> = {
    off: 'none',
    one: 'track',
    all: 'playlist'
};
