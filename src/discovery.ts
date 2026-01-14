import { Shortcuts } from '@basmilius/homey-common';
import type { AppleApp, StrategyKey } from './types';
import type Homey from 'homey';

const STRATEGY_KEYS: StrategyKey[] = [
    'appletv-airplay',
    'appletv-companion-link',
    'homepod',
    'homepod-mini'
];

export default class extends Shortcuts<AppleApp> {
    readonly #results: Record<StrategyKey, Map<string, Homey.DiscoveryResultMDNSSD>>;
    readonly #strategies: Record<StrategyKey, Homey.DiscoveryStrategy>;

    constructor(app: AppleApp) {
        super(app);

        this.#strategies = {
            'appletv-airplay': this.homey.discovery.getStrategy('appletv-airplay'),
            'appletv-companion-link': this.homey.discovery.getStrategy('appletv-companion-link'),
            'homepod': this.homey.discovery.getStrategy('homepod'),
            'homepod-mini': this.homey.discovery.getStrategy('homepod-mini')
        };

        this.#results = {
            'appletv-airplay': new Map(),
            'appletv-companion-link': new Map(),
            'homepod': new Map(),
            'homepod-mini': new Map()
        };

        this.#initialize();
        this.#subscribe();
    }

    get(strategyKey: StrategyKey, id: string): Homey.DiscoveryResultMDNSSD | undefined {
        return this.#results[strategyKey].get(id);
    }

    #initialize(): void {
        for (const key of STRATEGY_KEYS) {
            const strategy = this.#strategies[key];
            const existingResults = strategy.getDiscoveryResults();

            for (const [id, result] of Object.entries(existingResults)) {
                this.#results[key].set(id, result as Homey.DiscoveryResultMDNSSD);
            }
        }
    }

    #subscribe(): void {
        for (const key of STRATEGY_KEYS) {
            const strategy = this.#strategies[key];

            strategy.on('result', (result: Homey.DiscoveryResultMDNSSD) => {
                this.#results[key].set(result.id, result);
                this.log(`Discovery result added/updated for ${key}: ${result.id}`);
            });
        }
    }
}
