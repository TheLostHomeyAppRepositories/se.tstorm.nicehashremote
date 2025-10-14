'use strict';

import Homey from 'homey';
import NiceHashLib from '../../nicehash/lib';

/**
 * NiceHash Rig device - monitors and controls individual mining rigs.
 * Implements Autopilot system for profitability-based start/stop automation.
 *
 * Core Features:
 * - Real-time rig monitoring (60-second updates)
 * - Hash rate normalization from H to EH
 * - Profitability calculation in mBTC and local currency
 * - Autopilot: automatic start/stop based on net profitability
 * - Rolling profit averaging (7-minute window)
 * - Tariff limit learning
 * - Cumulative power and revenue metering
 * - Support for both legacy and v4 devices
 *
 * Autopilot Algorithm:
 * 1. Calculate net profitability = (revenue - power cost) / power cost * 100%
 * 2. Maintain 7-minute rolling average to smooth variance
 * 3. If rolling profit < threshold for 7 minutes: stop mining, record tariff limit
 * 4. Won't restart until power tariff drops below learned limit (or 7-hour timeout)
 * 5. If profitable: raise tariff limit to allow mining at higher rates
 *
 * Dependencies:
 * - Uses: nicehash/lib.ts for API operations
 * - Syncs every: 60 seconds (rig details), 60 minutes (algorithms)
 *
 * @class NiceHashRigDevice
 * @extends {Homey.Device}
 */
class NiceHashRigDevice extends Homey.Device {

  niceHashLib: NiceHashLib | undefined; // NiceHash API library instance
  details: any; // Last fetched rig details from NiceHash
  detailsSyncTimer: any; // Timer for 60-second rig detail sync
  lastSync: number = 0; // Timestamp of last successful sync (for cumulative meters)
  lastMined: number = 0; // Timestamp when rig was last actively mining
  benchmarkStart: number = 0; // When current profitability benchmark period started
  smartMagicNumber: number = 7; // Rolling average window: 7 minutes
  rollingProfit: number = 0; // Rolling average of net profitability percentage
  algorithms: any; // Algorithm lookup table for v4 devices (indexed by order/ID)
  getAlgorithmsTimer: any; // Timer for hourly algorithm list refresh

  /**
   * Initializes the rig device.
   * Sets up capabilities, timers, and capability listeners for rig control.
   *
   * Complexity: O(1) - fixed initialization steps
   *
   * Initialization sequence:
   * 1. Create NiceHashLib instance
   * 2. Start hourly algorithm refresh timer
   * 3. Add missing capabilities (for app updates)
   * 4. Start 60-second rig detail sync
   * 5. Register capability listeners (onoff, smart_mode, smart_mode_min_profitability)
   *
   * Capabilities added if missing:
   * - smart_mode: Autopilot enable/disable
   * - measure_cost_scarab: Power cost in local currency
   * - measure_profit_scarab: Revenue in local currency
   * - meter_cost_scarab: Cumulative cost in local currency
   * - meter_profit_scarab: Cumulative revenue in local currency
   * - measure_profit_percent: Net profitability percentage
   * - measure_temperature: GPU temperature
   * - measure_load: GPU load percentage
   * - power_mode: LOW/MEDIUM/HIGH
   * - measure_tariff_limit: Learned tariff limit
   * - smart_mode_min_profitability: Minimum profitability threshold
   *
   * @returns {Promise<void>}
   */
  async onInit() {
    this.log('NiceHashRigDevice has been initialized');
    this.niceHashLib = new NiceHashLib();

    // Start hourly algorithm refresh (needed for v4 device algorithm names)
    this.algorithms = [];
    this.getAlgorithmsTimer = this.homey.setInterval(() => {
      this.getAlgorithms();
    }, 60 * 60 * 1000); // 60 minutes

    // Add capabilities if missing (ensures compatibility after app updates)
    if (!this.hasCapability('smart_mode')) await this.addCapability('smart_mode');
    if (!this.hasCapability('measure_cost_scarab')) await this.addCapability('measure_cost_scarab');
    if (!this.hasCapability('measure_profit_scarab')) await this.addCapability('measure_profit_scarab');
    if (!this.hasCapability('meter_cost_scarab')) await this.addCapability('meter_cost_scarab');
    if (!this.hasCapability('meter_profit_scarab')) await this.addCapability('meter_profit_scarab');
    if (!this.hasCapability('measure_profit_percent')) await this.addCapability('measure_profit_percent');
    if (!this.hasCapability('measure_temperature')) await this.addCapability('measure_temperature');
    if (!this.hasCapability('measure_load')) await this.addCapability('measure_load');
    if (!this.hasCapability('power_mode')) await this.addCapability('power_mode');
    if (!this.hasCapability('measure_tariff_limit')) await this.addCapability('measure_tariff_limit');
    if (!this.hasCapability('smart_mode_min_profitability')) await this.addCapability('smart_mode_min_profitability');

    // Start rig detail synchronization (immediate + 60-second interval)
    this.syncRigDetails().catch(this.error);
    this.detailsSyncTimer = this.homey.setInterval(() => {
      this.syncRigDetails().catch(this.error);
    }, 60000); // 60 seconds

    // Register capability listeners for user interactions
    this.registerCapabilityListener('onoff', async value => {
      console.log('Device onoff =', value);
      await this.niceHashLib?.setRigStatus(this.getData().id, value);
    });

    this.registerCapabilityListener('smart_mode', async value => {
      console.log('Autopilot =', value);
      // When Autopilot is enabled, start rig to begin profitability assessment
      await this.niceHashLib?.setRigStatus(this.getData().id, value);
    });

    this.registerCapabilityListener('smart_mode_min_profitability', async value => {
      console.log('Autopilot Min Net Profitability', value);
      await this.setCapabilityValue('smart_mode_min_profitability', value);
    });
  }

  /**
   * Fetches mining algorithms from NiceHash API.
   * Updates algorithm lookup table indexed by algorithm order (ID).
   * Required for v4 devices which return algorithm IDs instead of names.
   *
   * Complexity: O(n) where n = number of algorithms (~50)
   *
   * @returns {Promise<void>}
   * @private
   */
  private async getAlgorithms() {
    if (this.niceHashLib) {
      const algos = await this.niceHashLib.getAlgorithms().catch(this.error);
      if (algos && algos.miningAlgorithms) {
        this.algorithms = [];
        // Index algorithms by 'order' field for quick lookup
        for (const algo of algos.miningAlgorithms) {
          this.algorithms[algo.order] = algo;
        }
      }
    }
  }

  /**
   * Synchronizes rig status with NiceHash and implements Autopilot profitability logic.
   * Called every 60 seconds. This is the core method containing the Autopilot algorithm.
   *
   * Complexity: O(d) where d = number of devices in rig (typically 1-8 GPUs)
   *
   * Main Algorithm Flow:
   * 1. Fetch rig details from NiceHash API
   * 2. Aggregate power, temperature, load, and hash rates from all devices
   * 3. Normalize hash rates from H/kH/MH/GH/TH/PH/EH to MH
   * 4. Handle both legacy devices and v4 devices (with algorithm lookup)
   * 5. Calculate profitability in mBTC and local currency
   * 6. Update cumulative meters (power, revenue, cost)
   * 7. AUTOPILOT LOGIC:
   *    a. If NOT mining + Autopilot enabled + (no tariff limit OR tariff below limit OR 7-hour timeout):
   *       → START mining to assess profitability
   *    b. If mining + hashrate available:
   *       - Calculate rolling profit average (7-minute EMA window)
   *       - After 7-minute benchmark period:
   *         * If rolling profit < threshold AND instant profit < threshold:
   *           → STOP mining, record current tariff as limit
   *         * If profitable and tariff > limit:
   *           → RAISE tariff limit to current tariff
   *
   * Autopilot Start Conditions (ANY of these):
   * - No tariff limit set (tariff_limit === -1)
   * - Current tariff below learned limit (tariff < tariff_limit)
   * - Haven't mined in 7 hours (forces re-benchmark)
   *
   * Autopilot Stop Conditions (BOTH must be true):
   * - Rolling 7-minute average < minimum profitability
   * - Current instant profitability < minimum profitability
   *
   * Rolling Average Formula:
   * rollingProfit = rollingProfit * (6/7) + currentProfit * (1/7)
   * This is an Exponential Moving Average (EMA) with α = 1/7
   *
   * @returns {Promise<void>}
   * @private
   */
  async syncRigDetails() {
    const settings = this.getSettings();
    let powerUsage = 0.0;
    let algorithms = '';
    let hashrate = 0.0;
    let mining = 0;
    let temperature = 0;
    let load = 0;
    const details = await this.niceHashLib?.getRigDetails(this.getData().id);
    const power_tariff = this.homey.settings.get('tariff');
    const power_tariff_currency = this.homey.settings.get('tariff_currency') || 'USD';
    const smart_mode = await this.getCapabilityValue('smart_mode');
    const smart_mode_min_profitability = settings.smart_mode_min_profitability || 0;
    await this.setCapabilityValue('smart_mode_min_profitability', smart_mode_min_profitability).catch(this.error);

    // If we don't have rig details, we can't do anything
    if (!details || !details.type || details.type === 'UNMANAGED') return;

    const tariff_limit = this.getStoreValue('tariff_limit') || -1;
    if (tariff_limit !== -1) this.setCapabilityValue('measure_tariff_limit', tariff_limit).catch(this.error);

    if (details.minerStatus) this.setCapabilityValue('status', details.minerStatus).catch(this.error);
    if (details.rigPowerMode) this.setCapabilityValue('power_mode', details.rigPowerMode).catch(this.error);

    // console.log(details);

    console.log(`───────────────────────────────────────────────────────\n[${this.getName()}]`);
    console.log('   Power tariff: ', power_tariff);
    console.log('   Tariff limit: ', tariff_limit);

    if (details.devices || details.hasV4Rigs) {
      if (details.devices) {
        for (const device of details.devices) {
          if (device.status.enumName === 'DISABLED' || device.status.enumName === 'OFFLINE') continue;

          temperature = Math.max(temperature, device.temperature);
          powerUsage += device.powerUsage;
          load += device.load;

          if (device.status.enumName !== 'MINING') continue;

          mining++;

          for (const speed of device.speeds) {
            if (!algorithms.includes(speed.title)) {
              algorithms += (algorithms ? ', ' : '') + speed.title;
            }
            // Normalize all hash rates to MH (megahashes) for consistency
            let r = Number.parseFloat(speed.speed);
            switch (speed.displaySuffix) {
              case 'H':
                r /= 1000000; // H → MH: Divide by 1M (A for effort)
                break;
              case 'kH':
                r /= 1000; // kH → MH: Divide by 1K (You'll get there)
                break;
              case 'GH':
                r /= 0.001; // GH → MH: Multiply by 1K (Wow, cool rig)
                break;
              case 'TH':
                r /= 0.000001; // TH → MH: Multiply by 1M (Hi Elon)
                break;
              case 'PH':
                r /= 0.000000001; // PH → MH: Multiply by 1B (Holy shit, well this will probably overflow but you can afford it)
                break;
              case 'EH':
                r /= 0.000000000001; // EH → MH: Multiply by 1T (Godspeed, sheik)
                break;
              default:
                break; // MH or unknown unit - use as-is (Hi average miner)
            }
            hashrate += r;
          }
        }
      }

      if (details.hasV4Rigs && details.v4 && details.v4.devices) {
        for (const device of details.v4.devices) {
          // console.log(device);
          if (device.mdv && device.mdv.algorithmsSpeed) {
            for (const algo of device.mdv.algorithmsSpeed) {
              // console.log(algo);
              // console.log(this.algorithms[algo.algorithm]);
              if (!this.algorithms || !this.algorithms[algo.algorithm]) await this.getAlgorithms();
              if (this.algorithms[algo.algorithm]) algorithms += (algorithms ? ', ' : '') + this.algorithms[algo.algorithm].title;
              const r = Number.parseFloat(algo.speed) / 1_000_000;

              if (r > 0) mining++;

              hashrate += r;
            }
          }

          for (const keypair of device.odv) {
            if (keypair.key === 'Power usage') powerUsage += Number.parseFloat(keypair.value);
            if (keypair.key === 'Temperature') temperature = Math.max(temperature, Number.parseFloat(keypair.value));
            if (keypair.key === 'Load') load += Number.parseFloat(keypair.value);
          }
        }
      }

      console.log(`      Algorithm: ${algorithms || '-'}`);
      console.log(`      Hash Rate: ${hashrate}`);
      console.log(`         Status: ${details.minerStatus}`);

      this.setCapabilityValue('algorithm', algorithms || '-').catch(this.error);
      this.setCapabilityValue('measure_temperature', temperature).catch(this.error);
      this.setCapabilityValue('measure_load', load).catch(this.error);
      this.setCapabilityValue('hashrate', Math.round(hashrate * 100) / 100).catch(this.error);
      this.setStoreValue('hashrate', hashrate);
      this.setCapabilityValue('onoff', !(details.minerStatus === 'STOPPED' || details.minerStatus === 'OFFLINE')).catch(this.error);
      this.setStoreValue('measure_power', powerUsage);
      this.setCapabilityValue('measure_power', Math.round(powerUsage * 100) / 100).catch(this.error);

      if (this.details
        && this.details.minerStatus !== details.minerStatus) {
        // console.log(this.getName() + ' old status="' + (this.details ? this.details.minerStatus : 'unknown') + '", new status="' + details.minerStatus + '"');
        const statusChangedTrigger = this.homey.flow.getTriggerCard('rig_status_changed');
        const tokens = {
          name: this.getName(),
          status: details.minerStatus,
        };
        statusChangedTrigger.trigger(tokens).catch(this.error);
      }
      this.details = details;

      if (mining === 0) {
        this.setStoreValue('mining', 0);
        this.setStoreValue('measure_profit', 0);
        this.setCapabilityValue('measure_profit', 0);
        this.setStoreValue('measure_profit_scarab', 0);
        this.setCapabilityValue('measure_profit_scarab', 0);
        this.setStoreValue('measure_profit_percent', 0);
        this.setCapabilityValue('measure_profit_percent', 0);

        this.setStoreValue('measure_cost', 0);
        this.setCapabilityValue('measure_cost', 0);
        this.setStoreValue('measure_cost_scarab', 0);
        this.setCapabilityValue('measure_cost_scarab', 0);

        this.lastSync = 0;
        this.benchmarkStart = 0;
        this.rollingProfit = 0;

        // AUTOPILOT START LOGIC: Determine if rig should start mining
        if (smart_mode
          && (tariff_limit === -1 || tariff_limit > power_tariff
            || this.lastMined === 0 || (this.lastMined && Date.now() - this.lastMined > 1000 * 60 * 60 * this.smartMagicNumber))) {
          // Start mining if ALL of these are true:
          // 1. Autopilot is enabled (smart_mode = true)
          // 2. We're not currently mining (mining === 0)
          // 3. AND ANY of these conditions:
          //    a) No tariff limit learned yet (tariff_limit === -1)
          //    b) Current tariff is below learned limit (tariff < tariff_limit)
          //    c) Haven't mined in 7 hours (forces periodic re-benchmark)
          console.log('Autopilot starting rig (tariff limit = ', tariff_limit, 'power_tariff = ', `${power_tariff})`);
          await this.niceHashLib?.setRigStatus(this.getData().id, true);
        }

        return;
      }

      if (!hashrate) {
        // We're mining but we don't have a hashrate, so we're probably waiting for a job
        console.log('Waiting for job, setting profitability to 0...');
        details.profitability = 0;
      }

      this.setStoreValue('measure_profit', details.profitability * 1000.0);
      this.setCapabilityValue('measure_profit', Math.round((details.profitability * 1000.0) * 100) / 100).catch(this.error);
      this.setStoreValue('mining', 1);

      this.lastMined = Date.now();

      let costPerDay = 0;
      let costPerDayMBTC = 0;
      let bitcoinRate = null;
      let mBTCRate = 0;
      let profitPct = 0;
      if (power_tariff && power_tariff_currency) {
        bitcoinRate = this.niceHashLib?.getBitcoinRate(power_tariff_currency);
        if (bitcoinRate) {
          if (mining > 0) {
            // Calculate profitability
            const profitabilityScarab = details.profitability * bitcoinRate['15m'];
            this.setCapabilityValue('measure_profit_scarab', Math.round(profitabilityScarab * 100) / 100);
            this.setStoreValue('measure_profit_scarab', profitabilityScarab);
          }

          // Calculate cost per day
          costPerDay = power_tariff * powerUsage / 1000 * 24;
          this.setCapabilityValue('measure_cost_scarab', Math.round(costPerDay * 100) / 100);
          this.setStoreValue('measure_cost_scarab', costPerDay);

          mBTCRate = bitcoinRate['15m'] / 1000.0;
          const powerMBTCRate = (1 / mBTCRate) * power_tariff;

          costPerDayMBTC = costPerDay / mBTCRate;

          this.setCapabilityValue('measure_cost', Math.round(costPerDayMBTC * 100) / 100);
          this.setStoreValue('measure_cost', costPerDayMBTC);

          console.log(`        1 mBTC = ${mBTCRate} ${power_tariff_currency}`);
          console.log(`  Power tariff = ${power_tariff} ${power_tariff_currency}/kWh = ${powerMBTCRate} mBTC/kWh`);
          console.log(`          Cost = ${costPerDayMBTC} mBTC/24h = ${costPerDayMBTC * mBTCRate} ${power_tariff_currency}/24h`);

          if (mining > 0 && costPerDayMBTC > 0) {
            // Calculate profit
            const revenue = (details.profitability * 1000.0);
            const profit = (revenue - costPerDayMBTC);
            console.log(`        Revenue: ${revenue} mBTC/24h`);
            console.log(`           Cost: ${costPerDayMBTC} mBTC/24h`);
            console.log(`         Profit: ${profit} mBTC/24h`);
            profitPct = Math.round((profit / costPerDayMBTC) * 100);
            console.log(`                 (${profitPct}%)`);

            this.setStoreValue('measure_profit_percent', profitPct);
            this.setCapabilityValue('measure_profit_percent', profitPct);
          }
        }
      }

      if (this.lastSync > 0) {
        const now = new Date().getTime(); // milliseconds
        const meter_power = this.getStoreValue('meter_power') || 0;
        const power_add = (powerUsage / 1000) * ((now - this.lastSync) / (1000 * 60 * 60));
        console.log(`      power_add: ${power_add} kWh`);
        this.setStoreValue('meter_power', meter_power + power_add);
        console.log(`   meter_power = ${meter_power} kWh`);
        this.setCapabilityValue('meter_power', Math.round((meter_power) * 100) / 100).catch(this.error);

        const meter_profit = this.getStoreValue('meter_profit') || 0;
        console.log(`   meter_profit: ${meter_profit}`);
        const mbtc_profit_add = (details.profitability * 1000) * ((now - this.lastSync) / (86400000));
        console.log(`mbtc_profit_add: ${mbtc_profit_add}`);
        this.setStoreValue('meter_profit', meter_profit + mbtc_profit_add);
        this.setCapabilityValue('meter_profit', Math.round((meter_profit + mbtc_profit_add) * 100) / 100).catch(this.error);
        if (mBTCRate) {
          const profitScarab = (meter_profit + mbtc_profit_add) * mBTCRate;
          this.setStoreValue('meter_profit_scarab', profitScarab);
          this.setCapabilityValue('meter_profit_scarab', Math.round(profitScarab * 100) / 100).catch(this.error);
        }

        const meter_cost = this.getStoreValue('meter_cost') || 0;
        console.log(`     meter_cost: ${meter_cost}`);
        const mbtc_cost_add = costPerDayMBTC * ((now - this.lastSync) / (86400000));
        console.log(`  mbtc_cost_add: ${mbtc_cost_add}`);
        const new_meter_cost = meter_cost + mbtc_cost_add;
        this.setStoreValue('meter_cost', new_meter_cost);
        this.setCapabilityValue('meter_cost', Math.round(new_meter_cost * 100) / 100).catch(this.error);
        if (mBTCRate) {
          this.setStoreValue('meter_cost_scarab', new_meter_cost * mBTCRate);
          this.setCapabilityValue('meter_cost_scarab', Math.round((new_meter_cost * mBTCRate) * 100) / 100).catch(this.error);
        }

        if (hashrate) { // Skip profitability assessment if waiting for mining job
          // ROLLING PROFIT CALCULATION: Exponential Moving Average over 7 minutes
          if (this.benchmarkStart === 0) {
            // First profitability reading: initialize benchmark period
            this.benchmarkStart = new Date().getTime();
            this.rollingProfit = profitPct;
          } else {
            // Update rolling average using EMA formula:
            // newAvg = oldAvg * (6/7) + newValue * (1/7)
            // This gives more weight to recent values while smoothing out variance
            this.rollingProfit = this.rollingProfit * ((this.smartMagicNumber - 1) / this.smartMagicNumber) + profitPct * (1 / this.smartMagicNumber);
          }

          console.log(' Rolling Profit:', this.rollingProfit, '%');

          // AUTOPILOT STOP LOGIC: Only make decisions after 7-minute benchmark period
          if (this.benchmarkStart > 0 && (new Date().getTime() - this.benchmarkStart) > this.smartMagicNumber * 60000) {
            // Benchmark period complete (7 minutes of mining data collected)

            if (this.rollingProfit < smart_mode_min_profitability && profitPct < smart_mode_min_profitability) {
              // STOP CONDITION: Both rolling average AND instant profit below threshold
              // This dual check prevents stopping due to temporary profit dips
              console.log('Rig is not profitable (profit = ', profitPct, ' rolling profit = ', this.rollingProfit, '%', 'minimum profitability = ', smart_mode_min_profitability, '%)');

              // Learn tariff limit: record current tariff as "unprofitable threshold"
              // Rig won't restart until tariff drops below this limit
              console.log('Setting tariff limit to ', power_tariff, ' (was ', tariff_limit, ')');
              this.setStoreValue('tariff_limit', power_tariff);

              if (smart_mode) {
                // Autopilot enabled: stop mining
                console.log('Autopilot stopping rig (tariff limit = ', tariff_limit, 'power_tariff = ', `${power_tariff})`);
                await this.niceHashLib?.setRigStatus(this.getData().id, false);
              }
            } else {
              // Rig is profitable: update tariff limit if current tariff is higher
              // This allows mining at progressively higher tariffs as long as it remains profitable
              if (power_tariff > tariff_limit) {
                console.log('Raising tariff limit to ', power_tariff, ' (was ', tariff_limit, ')');
                this.setStoreValue('tariff_limit', power_tariff);
              }
            }
          }
        }
      }
    }
    this.lastSync = new Date().getTime();
  }

  /**
   * Updates the Autopilot minimum profitability threshold.
   * Triggers a new benchmark by starting the rig (if not already mining).
   *
   * Complexity: O(1)
   *
   * @param {number} minProfitability - Minimum net profitability percentage (0-100)
   * @returns {Promise<void>}
   */
  async setSmartModeMinProfitability(minProfitability: number) {
    await this.setSettings({
      smart_mode_min_profitability: minProfitability,
    });
    // Start mining to assess profitability with new threshold
    // If already mining, this has no effect
    await this.niceHashLib?.setRigStatus(this.getData().id, true);
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
    this.log('NiceHashRigDevice has been added');
  }

  /**
   * Called when device settings are changed by the user.
   * Starts mining to re-assess profitability with new settings.
   *
   * Complexity: O(1)
   *
   * Settings:
   * - smart_mode_min_profitability: Minimum net profitability threshold
   *
   * @param {object} event - Settings event data
   * @param {object} event.oldSettings - Previous settings
   * @param {object} event.newSettings - Updated settings
   * @param {string[]} event.changedKeys - Array of changed setting keys
   * @returns {Promise<string|void>} Optional message to show user
   */
  async onSettings({ oldSettings: {}, newSettings: {}, changedKeys: {} }): Promise<string|void> {
    this.log('NiceHashRigDevice settings where changed');
    // Start mining to benchmark with new settings
    await this.niceHashLib?.setRigStatus(this.getData().id, true);
  }

  /**
   * Called when the device is renamed by the user.
   * Name is purely cosmetic and doesn't affect rig control.
   *
   * Complexity: O(1)
   *
   * @param {string} name - New device name
   * @returns {Promise<void>}
   */
  async onRenamed(name: string) {
    this.log('NiceHashRigDevice was renamed');
  }

  /**
   * Called when the device is deleted by the user.
   * Cleans up timers to prevent memory leaks.
   *
   * Complexity: O(1)
   *
   * @returns {Promise<void>}
   */
  async onDeleted() {
    this.log('NiceHashRigDevice has been deleted');
    // Stop all timers
    this.homey.clearInterval(this.detailsSyncTimer);
    this.homey.clearInterval(this.getAlgorithmsTimer);
  }

}

module.exports = NiceHashRigDevice;
