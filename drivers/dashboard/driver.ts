'use strict';

import Homey from 'homey';

/**
 * Dashboard driver for NiceHash Remote.
 * Manages the single Dashboard device that aggregates metrics from all rigs.
 * Unlike the rig driver, this always returns a fixed singleton device.
 *
 * Flow:
 * 1. onInit() - Driver initialization
 * 2. onPairListDevices() - Returns single Dashboard device for pairing
 * 3. User pairs Dashboard device (only one instance allowed)
 * 4. Dashboard device aggregates data from all rig devices
 *
 * Dependencies:
 * - Used by: Homey device pairing flow
 * - Creates: drivers/dashboard/device.ts (NiceHashDashboard)
 *
 * @class NiceHashDashboardDriver
 * @extends {Homey.Driver}
 */
class NiceHashDashboardDriver extends Homey.Driver {

  /**
   * Initializes the Dashboard driver.
   * Called once when the driver is loaded.
   *
   * Complexity: O(1)
   *
   * @returns {Promise<void>}
   */
  async onInit() {
    this.log('NiceHashDashboardDriver has been initialized');
  }

  /**
   * Returns the list of devices available for pairing.
   * Always returns a single Dashboard device with fixed ID.
   * Multiple Dashboard devices can be paired, but they all share the same ID.
   *
   * Complexity: O(1) - returns fixed singleton array
   *
   * @returns {Promise<Array<Object>>} Array with single Dashboard device
   * @returns {string} [].name - Device name shown in pairing UI
   * @returns {Object} [].data - Device data
   * @returns {string} [].data.id - Fixed device identifier
   * @example
   * // Returns:
   * [{ name: 'Dashboard', data: { id: 'nicehashremote-dashboard' } }]
   */
  async onPairListDevices() {
    return [
      {
        name: 'Dashboard',
        data: {
          id: 'nicehashremote-dashboard', // Fixed ID for Dashboard device
        }
      }
    ];
  }

}

module.exports = NiceHashDashboardDriver;
