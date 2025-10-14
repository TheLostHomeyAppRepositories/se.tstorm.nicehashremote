'use strict';

import Homey from 'homey';
import NiceHashLib from '../../nicehash/lib';

/**
 * NiceHash Dashboard device - aggregates metrics from all rig devices.
 * Provides fleet-wide view of total hashrate, power consumption, revenue, and costs.
 * Updates every 7 seconds by querying all paired rig devices.
 *
 * Flow:
 * 1. onInit() - Initialize device and start metric aggregation
 * 2. gatherDetails() - Every 7 seconds, sum metrics from all rigs
 * 3. Update dashboard capabilities with aggregated totals
 *
 * Dependencies:
 * - Reads from: All nicehash-rig devices via driver.getDevices()
 * - Uses device store values (not capabilities) for internal consistency
 *
 * @class NiceHashDashboard
 * @extends {Homey.Device}
 */
class NiceHashDashboard extends Homey.Device {

  niceHashLib: NiceHashLib | undefined; // NiceHash API library (initialized but not used)
  gatherDetailsTimer: any; // Timer for periodic metric aggregation

  /**
   * Initializes the Dashboard device.
   * Adds missing capabilities and starts periodic metric aggregation.
   *
   * Complexity: O(1) - initialization
   *
   * Capabilities ensured:
   * - hashrate: Total mining speed across all rigs
   * - rigs_mining: Count of active rigs (e.g., "2/5")
   *
   * Update interval: 7 seconds
   *
   * @returns {Promise<void>}
   */
  async onInit() {
    this.log('NiceHashDashboard has been initialized');
    this.niceHashLib = new NiceHashLib();

    // Add capabilities if missing (for app updates)
    if (!this.hasCapability('hashrate')) await this.addCapability('hashrate');
    if (!this.hasCapability('rigs_mining')) await this.addCapability('rigs_mining');

    // Start metric aggregation
    this.gatherDetails();
    this.gatherDetailsTimer = this.homey.setInterval(() => {
      this.gatherDetails();
    }, 7000); // 7-second refresh
  }

  /**
   * Generic type-safe property accessor (utility method).
   * Ensures TypeScript type safety when accessing object properties.
   *
   * Complexity: O(1)
   *
   * @template T - Object type
   * @template K - Key type (must be keyof T)
   * @param {T} o - Object to access
   * @param {K} propertyName - Property name to retrieve
   * @returns {T[K]} Property value with correct type
   */
  getProperty<T, K extends keyof T>(o: T, propertyName: K): T[K] {
    return o[propertyName]; // o[propertyName] is of type T[K]
  }

  /**
   * Aggregates metrics from all rig devices and updates dashboard capabilities.
   * Called every 7 seconds to maintain up-to-date fleet overview.
   *
   * Algorithm:
   * 1. Fetch all rig devices from rig driver
   * 2. Sum each metric from rig store values (not capabilities)
   * 3. Calculate fleet-wide net profitability percentage
   * 4. Update dashboard capabilities with rounded totals
   *
   * Complexity: O(n*m) where n = number of rigs, m = number of metrics (11)
   * In practice: O(n) since m is constant
   *
   * Metrics aggregated:
   * - measure_power: Current power consumption (W)
   * - meter_power: Cumulative power consumption (kWh)
   * - measure_profit: Current revenue (mBTC/24h and currency/24h)
   * - meter_profit: Cumulative revenue (mBTC and currency)
   * - measure_cost: Current power cost (mBTC/24h and currency/24h)
   * - meter_cost: Cumulative power cost (mBTC and currency)
   * - hashrate: Total mining speed (MH)
   *
   * @returns {Promise<void>}
   * @private
   */
  async gatherDetails() {
    const rigDriver = this.homey.drivers.getDriver('nicehash-rig');
    if (rigDriver) {
      const rigDevices = rigDriver.getDevices();

      // Initialize metric accumulators
      const metrics = new Map<string, number>([
        ['measure_power', 0],
        ['meter_power', 0],
        ['measure_profit', 0],
        ['measure_profit_scarab', 0],
        ['meter_profit', 0],
        ['meter_profit_scarab', 0],
        ['measure_cost', 0],
        ['measure_cost_scarab', 0],
        ['meter_cost', 0],
        ['meter_cost_scarab', 0],
        ['hashrate', 0],
      ]);

      // Sum each metric across all rigs
      metrics.forEach((value: number, metric: string) => {
        for (const rig of rigDevices) {
          const add = rig.getStoreValue(metric);
          value += add;
          metrics.set(metric, value); // Fixed: was "value + add" which double-counted each rig
        }
        // Update capability with rounded value (2 decimal places)
        this.setCapabilityValue(metric, Math.round(value * 100) / 100);
      });

      // Calculate rigs mining count
      let rigs_total = 0;
      let rigs_mining = 0;
      for (const rig of rigDevices) {
        rigs_total++;
        rigs_mining += rig.getStoreValue('mining') || 0; // mining: 1 or 0
      }
      this.setCapabilityValue('rigs_mining', `${rigs_mining}/${rigs_total}`);

      // Calculate fleet-wide net profitability percentage
      const revenue = metrics.get('measure_profit') || 0;
      const costPerDayMBTC = (metrics.get('measure_cost') || 0);
      const profit = (revenue - costPerDayMBTC);
      // Net profitability = (profit / cost) * 100
      const profitPct = Math.round((profit / costPerDayMBTC) * 100);

      this.setCapabilityValue('measure_profit_percent', profitPct);
    }
  }

  /**
   * Called when the device is added/paired by the user.
   * Lifecycle hook for post-pairing initialization.
   *
   * Complexity: O(1)
   *
   * @returns {Promise<void>}
   */
  async onAdded() {
    this.log('NiceHashDashboard has been added');
  }

  /**
   * Called when device settings are changed by the user.
   * Dashboard device has no settings, but hook is required by Homey.
   *
   * Complexity: O(1)
   *
   * @param {object} event - Settings event data
   * @param {object} event.oldSettings - Previous settings
   * @param {object} event.newSettings - Updated settings
   * @param {string[]} event.changedKeys - Array of changed setting keys
   * @returns {Promise<string|void>} Optional message to show user
   */
  async onSettings({ oldSettings: {}, newSettings: {}, changedKeys: {} }): Promise<string|void> {
    this.log('NiceHashDashboard settings where changed');
  }

  /**
   * Called when the device is renamed by the user.
   * Name is purely cosmetic and doesn't affect functionality.
   *
   * Complexity: O(1)
   *
   * @param {string} name - New device name
   * @returns {Promise<void>}
   */
  async onRenamed(name: string) {
    this.log('NiceHashDashboard was renamed');
  }

  /**
   * Called when the device is deleted by the user.
   * Cleans up the metric aggregation timer.
   *
   * Complexity: O(1)
   *
   * @returns {Promise<void>}
   */
  async onDeleted() {
    this.log('NiceHashDashboard has been deleted');
    // Stop metric aggregation to prevent memory leaks
    this.homey.clearInterval(this.gatherDetailsTimer);
  }

}

module.exports = NiceHashDashboard;
