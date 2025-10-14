'use strict';

import NiceHash from './api';

const fetch = require('node-fetch');

/**
 * High-level NiceHash API wrapper with Bitcoin exchange rate tracking.
 * Provides simplified interface for mining rig management and profitability calculations.
 *
 * Flow:
 * 1. Call init() to configure API credentials and sync server time
 * 2. Use getRigs() / getRigDetails() to query rig information
 * 3. Use setRigStatus() / setRigPowerMode() to control rigs
 * 4. Use getBitcoinRate() for profitability calculations
 *
 * Dependencies:
 * - Uses: nicehash/api.js (NiceHash API client)
 * - Used by: app.ts, drivers/nicehash-rig/device.ts, drivers/nicehash-rig/driver.ts
 * - Calls: blockchain.info ticker API (15-minute refresh)
 *
 * @class Lib
 * @example
 * const lib = new Lib();
 * await lib.init({
 *   locale: 'en',
 *   apiKey: 'key',
 *   apiSecret: 'secret',
 *   orgId: 'org123'
 * });
 * const rigs = await lib.getRigs();
 * const btcRate = lib.getBitcoinRate('USD');
 */
class Lib {

    static niceHashApi : NiceHash;
    static bitcoinTicker: any;
    /**
     * Self-executing async function that fetches Bitcoin exchange rates every 15 minutes.
     * Runs immediately on class load and schedules subsequent fetches.
     * Stores rates in Lib.bitcoinTicker for all currencies (USD, EUR, etc.).
     *
     * Rate source: blockchain.info/ticker
     * Update interval: 15 minutes
     * Error handling: Silent failure (errors caught but not propagated)
     */
    static bitcoinTickerReq = (async function getBitcoinTicker() {
      // Schedule next fetch in 15 minutes
      setTimeout(getBitcoinTicker, 15 * 60 * 1000);
      fetch('https://blockchain.info/ticker')
        .then((res: { text: () => any; }) => res.text())
        .then((text: any) => {
          Lib.bitcoinTicker = JSON.parse(text);
        })
        .catch((err: any) => {}); // Silent failure - profitability calculations will use stale data
    }());

    /**
     * Initializes the NiceHash API client with credentials and syncs server time.
     * Must be called before any API operations.
     *
     * Complexity: O(1) - makes 2 API calls (getTime + getRigs)
     *
     * @param {Object} options - API configuration
     * @param {string} options.locale - Language locale (e.g., 'en')
     * @param {string} options.apiKey - NiceHash API key
     * @param {string} options.apiSecret - NiceHash API secret
     * @param {string} options.orgId - NiceHash organization ID
     * @returns {Promise<boolean>} true if initialization successful, false otherwise
     * @example
     * const success = await lib.init({
     *   locale: 'en',
     *   apiKey: 'your-key',
     *   apiSecret: 'your-secret',
     *   orgId: 'your-org-id'
     * });
     */
    async init(options: { locale: string; apiKey: string; apiSecret: string; orgId: string; }) {
      try {
        // Initialize API client with NiceHash v2 endpoint
        Lib.niceHashApi = new NiceHash({
          apiHost: 'https://api2.nicehash.com',
          locale: options.locale,
          apiKey: options.apiKey,
          apiSecret: options.apiSecret,
          orgId: options.orgId,
        });

        // Sync with server time (required for authenticated requests)
        await Lib.niceHashApi.getTime().catch((err: any) => {});
        console.log(`NiceHash server time is ${Lib.niceHashApi.time}`);
        // Verify connection by fetching rigs
        const rigs = await this.getRigs();
        console.log(`${rigs.miningRigs.length} rigs found`);
        return true;
      } catch (ex) {
        console.log(ex);
      }
      return false;
    }

    /**
     * Fetches all mining rigs for the configured organization.
     *
     * Complexity: O(1) - single API call
     *
     * @returns {Promise<Object>} Rigs response with miningRigs array
     * @returns {Array} .miningRigs - Array of rig objects with rigId, name, status, etc.
     * @example
     * const data = await lib.getRigs();
     * console.log(data.miningRigs.length); // Number of rigs
     */
    async getRigs() {
      return await Lib.niceHashApi.get('/main/api/v2/mining/rigs2').catch((err: any) => { console.log(err.message) });
    }

    /**
     * Fetches detailed information for a specific mining rig.
     * Includes device list, mining status, power usage, temperatures, and speeds.
     *
     * Complexity: O(1) - single API call
     *
     * @param {String} rigId - Unique rig identifier
     * @returns {Promise<Object>} Rig details with devices, status, profitability
     * @returns {Array} .devices - Legacy devices with status, speeds, temperature, powerUsage
     * @returns {Object} .v4 - V4 device data (if hasV4Rigs is true)
     * @returns {string} .minerStatus - MINING, STOPPED, BENCHMARKING, OFFLINE, etc.
     * @returns {number} .profitability - Revenue in BTC/day
     * @example
     * const details = await lib.getRigDetails('abc123');
     * console.log(details.minerStatus); // "MINING"
     * console.log(details.profitability); // 0.00012
     */
    async getRigDetails(rigId: String) {
      return await Lib.niceHashApi.get(`/main/api/v2/mining/rig2/${rigId}`).catch((err: any) => { console.log(err.message) });
    }

    /**
     * Fetches list of available mining algorithms with current profitability data.
     * Used to map algorithm IDs to names for v4 devices.
     *
     * Complexity: O(1) - single API call
     *
     * @returns {Promise<Object>} Algorithms response
     * @returns {Array} .miningAlgorithms - Array with algorithm order (ID), title, speed units
     * @example
     * const algos = await lib.getAlgorithms();
     * const algoName = algos.miningAlgorithms[0].title; // "SCRYPT"
     */
    async getAlgorithms() {
      return await Lib.niceHashApi.get('/main/api/v2/mining/algorithms').catch((err: any) => { console.log(err.message) });
    }

    /**
     * Starts or stops a mining rig.
     * Used by Autopilot system and manual on/off controls.
     *
     * Complexity: O(1) - single API call
     *
     * @param {String} rigId - Unique rig identifier
     * @param {boolean} on - true to START mining, false to STOP
     * @returns {Promise<Object>} API response (typically {success: true})
     * @example
     * await lib.setRigStatus('abc123', true);  // Start mining
     * await lib.setRigStatus('abc123', false); // Stop mining
     */
    async setRigStatus(rigId: String, on: boolean) {
      const body = {
        rigId,
        action: (on ? 'START' : 'STOP'),
      };
      return await Lib.niceHashApi.post('/main/api/v2/mining/rigs/status2', { body }).catch((err: any) => { console.log(err.message) });
    }

    /**
     * Sets the power mode for a mining rig.
     * Power modes control GPU power limits and performance.
     *
     * Complexity: O(1) - single API call
     *
     * @param {String} rigId - Unique rig identifier
     * @param {String} mode - Power mode: 'LOW', 'MEDIUM', or 'HIGH'
     * @returns {Promise<Object>} API response
     * @example
     * await lib.setRigPowerMode('abc123', 'HIGH'); // Maximum performance
     * await lib.setRigPowerMode('abc123', 'LOW');  // Power saving
     */
    async setRigPowerMode(rigId: String, mode: String) {
      const body = {
        rigId,
        action: 'POWER_MODE',
        options: [mode],
      };
      return await Lib.niceHashApi.post('/main/api/v2/mining/rigs/status2', { body }).catch((err: any) => { console.log(err.message) });
    }

    /**
     * Gets current Bitcoin exchange rate for a specific currency.
     * Uses data from blockchain.info ticker (updated every 15 minutes).
     * Returns null if ticker data unavailable or currency not found.
     *
     * Complexity: O(1) - simple object lookup
     *
     * @param {any} currency - Currency code (e.g., 'USD', 'EUR', 'GBP')
     * @returns {Object|null} Rate object with '15m', 'last', 'buy', 'sell', 'symbol' or null
     * @returns {number} .15m - 15-minute delayed price
     * @returns {number} .last - Last transaction price
     * @returns {string} .symbol - Currency symbol (e.g., '$')
     * @example
     * const rate = lib.getBitcoinRate('USD');
     * if (rate) {
     *   console.log(rate['15m']); // 45000.50
     *   console.log(rate.symbol); // "$"
     * }
     */
    getBitcoinRate(currency: any) {
      if (Lib.bitcoinTicker && Lib.bitcoinTicker[currency]) {
        return Lib.bitcoinTicker[currency];
      }
      return null;
    }

}

export default Lib;
