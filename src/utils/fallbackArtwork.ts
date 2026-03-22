const fallbackArtwork: Record<string, string> = {
    'com.amazon.aiv.AIVApp': 'https://assets.bmcdn.nl/homey/com.basmilius.apple/com.amazon.aiv.AIVApp.png',
    'com.disney.disneyplus': 'https://assets.bmcdn.nl/homey/com.basmilius.apple/com.disney.disneyplus.png',
    'com.google.ios.youtube': 'https://assets.bmcdn.nl/homey/com.basmilius.apple/com.google.ios.youtube.png',
    'com.netflix.Netflix': 'https://assets.bmcdn.nl/homey/com.basmilius.apple/com.netflix.Netflix.png',
    'com.wbd.hbomax': 'https://assets.bmcdn.nl/homey/com.basmilius.apple/com.wbd.hbomax.png',
    'nl.nlziet.nlziet': 'https://assets.bmcdn.nl/homey/com.basmilius.apple/nl.nlziet.nlziet.png',
    'nl.rtl.videoland.v2': 'https://assets.bmcdn.nl/homey/com.basmilius.apple/nl.rtl.videoland.v2.png',
    'nl.thuisbioscoop.pathethuis': 'https://assets.bmcdn.nl/homey/com.basmilius.apple/nl.thuisbioscoop.pathethuis.png',
    'tv.twitch': 'https://assets.bmcdn.nl/homey/com.basmilius.apple/tv.twitch.png'
};

export const getFallbackArtworkUrl = (bundleIdentifier: string | null): string | null => {
    if (!bundleIdentifier) {
        return null;
    }

    return fallbackArtwork[bundleIdentifier] ?? null;
};
