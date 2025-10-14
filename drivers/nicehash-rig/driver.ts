'use strict';

import Homey from 'homey';
import NiceHashLib from '../../nicehash/lib';

/**
 * NiceHash Rig driver for managing individual mining rigs.
 * Handles device pairing and registers flow action cards for rig control.
 * Each rig device represents a physical mining rig in the NiceHash account.
 *
 * Flow:
 * 1. onInit() - Initialize driver and register flow cards
 * 2. onPairListDevices() - Fetch available rigs from NiceHash API
 * 3. User selects rigs to pair
 * 4. Rig devices created with individual monitoring and Autopilot control
 *
 * Dependencies:
 * - Uses: nicehash/lib.ts for API operations
 * - Used by: Homey device pairing flow
 * - Creates: drivers/nicehash-rig/device.ts (NiceHashRigDevice)
 *
 * @class NiceHashRigDriver
 * @extends {Homey.Driver}
 */
class NiceHashRigDriver extends Homey.Driver {

  niceHashLib: NiceHashLib | undefined; // NiceHash API library instance
  rigs: any; // Cached rigs list from pairing

  /**
   * Initializes the NiceHash Rig driver.
   * Creates NiceHashLib instance and registers flow action cards.
   *
   * Complexity: O(1) - initialization and card registration
   *
   * Flow cards registered:
   * - set_power_mode: Change rig power mode (LOW/MEDIUM/HIGH)
   * - set_smart_mode: Enable/disable Autopilot
   * - set_smart_mode_min_profitability: Set Autopilot minimum profitability threshold
   *
   * @returns {Promise<void>}
   */
  async onInit() {
    this.log('NiceHashRigDriver has been initialized');

    this.niceHashLib = new NiceHashLib();

    // Flow card: Set rig power mode
    const setPowerModeAction = this.homey.flow.getActionCard('set_power_mode');
    setPowerModeAction.registerRunListener(async (args, state) => {
      await this.niceHashLib?.setRigPowerMode(args.device.details.rigId, args.power_mode);
      return true;
    });

    // Flow card: Enable/disable Autopilot mode
    const setSmartModeAction = this.homey.flow.getActionCard('set_smart_mode');
    setSmartModeAction.registerRunListener(async (args, state) => {
      await args.device.setCapabilityValue('smart_mode', args.smart_mode);
      return true;
    });

    // Flow card: Set Autopilot minimum profitability threshold
    const setSmartModeMinProfitAction = this.homey.flow.getActionCard('set_smart_mode_min_profitability');
    setSmartModeMinProfitAction.registerRunListener(async (args, state) => {
      await args.device.setSmartModeMinProfitability(args.smart_mode_min_profitability);
      return true;
    });
  }

  /**
   * Returns list of available mining rigs for device pairing.
   * Fetches all rigs from NiceHash API and formats them for Homey pairing UI.
   *
   * Complexity: O(n) where n = number of rigs in account
   *
   * @returns {Promise<Array<Object>>} Array of rig devices available for pairing
   * @returns {string} [].name - Rig name from NiceHash
   * @returns {Object} [].data - Device data
   * @returns {string} [].data.id - NiceHash rig ID (rigId)
   * @example
   * // Returns:
   * [
   *   { name: 'Mining Rig 1', data: { id: 'abc123' } },
   *   { name: 'Mining Rig 2', data: { id: 'def456' } }
   * ]
   */
  async onPairListDevices() {
    // Fetch all rigs from NiceHash account
    this.rigs = await this.niceHashLib?.getRigs();
    const deviceArray = [];

    // Transform NiceHash rig data into Homey device format
    for (const rig of this.rigs.miningRigs) {
      deviceArray.push({
        name: rig.name, // Display name in pairing UI
        data: {
          id: rig.rigId, // Unique rig identifier
        },
      });
    }
    return deviceArray;
  }

}

module.exports = NiceHashRigDriver;
