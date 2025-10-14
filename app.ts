'use strict';

import Homey from 'homey';
import NiceHashLib from './nicehash/lib';

/**
 * NiceHash Remote - Homey app for monitoring and controlling NiceHash mining rigs.
 * Manages Bitcoin price monitoring, flow cards, and global settings for tariffs.
 *
 * Flow:
 * 1. onInit() - Initialize NiceHash API and register flow cards
 * 2. niceHashInit() - Configure API with credentials from settings
 * 3. youSuffer() - Monitor BTC price changes every 13 seconds (Gilfoyle reference)
 *
 * Dependencies:
 * - Uses: nicehash/lib.ts for API operations
 * - Used by: Drivers instantiate their own NiceHashLib instances
 * - Settings: nicehash_apiKey, nicehash_apiSecret, nicehash_orgId, tariff, tariff_currency
 *
 * @class NiceHashRemote
 * @extends {Homey.App}
 */
class NiceHashRemote extends Homey.App {

  niceHashLib: NiceHashLib | undefined;
  lastBitcoinRate: any; // Previous BTC rate for change detection
  bitcoinRateToken: any; // Flow token for current BTC price
  bitcoinCurrencyToken: any; // Flow token for currency code

  /**
   * Initializes the NiceHash Remote app.
   * Sets up NiceHash API client, registers flow action cards, and starts BTC price monitoring.
   *
   * Complexity: O(1) - constant initialization
   *
   * Flow cards registered:
   * - set_tariff_power: Updates electricity tariff (cost per kWh)
   * - set_tariff_power_currency: Sets currency for tariff (USD, EUR, etc.)
   *
   * @returns {Promise<void>}
   */
  async onInit() {
    // Initialize NiceHash API with credentials from settings
    await this.niceHashInit();

    // Register flow card: Set power tariff
    const setTariffPowerAction = this.homey.flow.getActionCard('set_tariff_power');
    setTariffPowerAction.registerRunListener(async (args, state) => {
      this.homey.settings.set('tariff', args.tariff);
    });

    // Register flow card: Set power tariff currency
    const setTariffPowerCurrencyAction = this.homey.flow.getActionCard('set_tariff_power_currency');
    setTariffPowerCurrencyAction.registerRunListener(async (args, state) => {
      this.homey.settings.set('tariff_currency', args.tariff_currency);
    });

    // Start Bitcoin price monitoring (every 13 seconds)
    setInterval(() => {
      this.youSuffer();
    }, 13000);
  }

  /**
   * Initializes NiceHash API library with credentials from Homey settings.
   * Only initializes if all required credentials are configured.
   *
   * Complexity: O(1) - reads settings and initializes library
   *
   * Required settings:
   * - nicehash_apiKey: NiceHash API key
   * - nicehash_apiSecret: NiceHash API secret
   * - nicehash_orgId: NiceHash organization ID
   * - nicehash_locale: Language locale (optional, defaults to 'en')
   *
   * @returns {Promise<boolean|undefined>} true if initialized successfully, undefined if credentials missing
   * @private
   */
  async niceHashInit() {
    this.lastBitcoinRate = null;
    this.niceHashLib = new NiceHashLib();
    const options = {
      locale: this.homey.settings.get('nicehash_locale') || 'en',
      apiKey: this.homey.settings.get('nicehash_apiKey'),
      apiSecret: this.homey.settings.get('nicehash_apiSecret'),
      orgId: this.homey.settings.get('nicehash_orgId'),
    };
    // Only initialize if all required credentials are present
    if (options.apiKey && options.apiSecret && options.orgId) {
      return await this.niceHashLib.init(options);
    }
  }

  /**
   * Monitors Bitcoin price changes and triggers flow when threshold exceeded.
   * Named after Gilfoyle's Bitcoin obsession in HBO's Silicon Valley.
   * Called every 13 seconds by setInterval in onInit().
   *
   * Algorithm:
   * 1. Fetch current BTC rate for configured currency
   * 2. Update flow tokens with current rate
   * 3. Calculate percentage change from last check
   * 4. If |change| >= threshold, trigger 'you_suffer' flow card
   *
   * Complexity: O(1) - simple calculations and lookups
   *
   * Settings used:
   * - tariff_currency: Currency for BTC rate (default: 'USD')
   * - gilfoyle_threshold: Minimum % change to trigger flow (default: 5%)
   *
   * Flow tokens created:
   * - nicehash_bitcoin_rate: Current BTC price
   * - nicehash_bitcoin_currency: Currency code
   *
   * Flow trigger: 'you_suffer' with tokens:
   * - btc_rate_old: Previous price
   * - btc_rate: Current price
   * - pct_change: Percentage change
   * - currency: Currency code
   *
   * @returns {Promise<void>}
   * @private
   */
  async youSuffer() {
    const power_tariff_currency = this.homey.settings.get('tariff_currency') || 'USD';
    const bitcoinRate = this.niceHashLib?.getBitcoinRate(power_tariff_currency);
    const gilfoyle_threshold = this.homey.settings.get('gilfoyle_threshold') || 5;

    if (bitcoinRate) {
      // Create flow tokens on first run (lazy initialization)
      if (!this.bitcoinRateToken) {
        this.bitcoinRateToken = await this.homey.flow.createToken('nicehash_bitcoin_rate', {
          type: 'number',
          title: 'BTC Price',
        });
      }
      if (!this.bitcoinCurrencyToken) {
        this.bitcoinCurrencyToken = await this.homey.flow.createToken('nicehash_bitcoin_currency', {
          type: 'string',
          title: 'BTC Price Currency',
        });
      }

      // Update tokens with current values
      await this.bitcoinRateToken.setValue(bitcoinRate['15m']);
      await this.bitcoinCurrencyToken.setValue(power_tariff_currency);
    }

    // Check for significant price changes
    if (this.lastBitcoinRate && bitcoinRate) {
      // Calculate percentage change: (new - old) / old * 100
      let change = ((bitcoinRate['15m'] - this.lastBitcoinRate['15m']) / this.lastBitcoinRate['15m']) * 100.0;

      // Trigger flow if absolute change exceeds threshold
      if (Math.abs(change) >= gilfoyle_threshold) {
        change = parseFloat(change.toFixed(1)); // Round to 1 decimal
        console.log(`!!! BTC price changed by ${change}% *HGEFBLURGH*`);
        const statusChangedTrigger = this.homey.flow.getTriggerCard('you_suffer');
        const tokens = {
          btc_rate_old: this.lastBitcoinRate['15m'],
          btc_rate: bitcoinRate['15m'],
          pct_change: change,
          currency: power_tariff_currency,
        };
        statusChangedTrigger.trigger(tokens).catch(this.error);
        // Update last rate only when threshold crossed (avoids repeated triggers)
        this.lastBitcoinRate = bitcoinRate;
      }
    } else this.lastBitcoinRate = bitcoinRate; // First run: store initial rate
  }

}

module.exports = NiceHashRemote;
