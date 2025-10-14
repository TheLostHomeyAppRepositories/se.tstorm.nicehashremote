# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NiceHash Remote is a Homey Pro app for monitoring and controlling NiceHash mining rigs. It integrates with the NiceHash API to provide real-time metrics, profitability tracking, and automated rig management based on electricity costs.

## Development Commands

### Build
```bash
npm run build
```
Compiles TypeScript to JavaScript. Required before testing changes.

### Lint
```bash
npm run lint
```
Runs ESLint with Athom's configuration on `.js` and `.ts` files.

## Architecture

### Homey SDK Integration

This app uses **Homey SDK v3** (`@types/homey: npm:homey-apps-sdk-v3-types`). The app manifest (`app.json`) is generated from `.homeycompose/` directory - **never edit `app.json` directly**.

### Core Components

**App Entry Point** (`app.ts`)
- Initializes NiceHash API connection with credentials from settings (apiKey, apiSecret, orgId)
- Registers flow action cards for power tariff configuration
- Monitors Bitcoin price changes (13-second poll interval) and triggers `you_suffer` flow when price changes exceed threshold
- Creates global flow tokens for BTC price and currency

**NiceHash API Layer** (`nicehash/`)
- `api.js`: HMAC-SHA256 authenticated requests to NiceHash API v2
- `lib.ts`: Higher-level API wrapper providing methods like `getRigs()`, `setRigStatus()`, `setRigPowerMode()`
- Fetches Bitcoin exchange rates from blockchain.info ticker (15-minute refresh)

**Drivers**

*NiceHash Rig Driver* (`drivers/nicehash-rig/`)
- Manages individual mining rigs as Homey devices
- **Device sync**: Polls rig details every 60 seconds (`syncRigDetails()`)
- Supports both legacy devices and v4 devices (hasV4Rigs)
- Calculates profitability metrics in both mBTC and configured currency
- Tracks cumulative power consumption and revenue meters

*Dashboard Driver* (`drivers/dashboard/`)
- Aggregates metrics across all rig devices (every 7 seconds)
- Provides fleet-wide view of hashrate, power, costs, and profitability

### Autopilot System

The Autopilot feature (`smart_mode` capability) automatically starts/stops rigs based on profitability:

1. **Profitability Calculation**: Net profitability = (revenue - power costs) / power costs × 100%
2. **Rolling Average**: Uses 7-minute rolling average (`smartMagicNumber = 7`) to smooth out variance
3. **Tariff Limit**: Learns the highest profitable tariff and won't restart until power cost drops below it
4. **Benchmark Period**: Requires 7 minutes of mining data before making decisions
5. **Force Rebenchmark**: After 7 hours of not mining, forces a new benchmark run

Key logic in `device.ts:syncRigDetails()`:
- Lines 224-232: Start conditions (autopilot enabled, tariff acceptable, or 7-hour timeout)
- Lines 342-363: Stop/continue decision based on rolling profitability vs `smart_mode_min_profitability`

### Capabilities System

Custom capabilities defined in `.homeycompose/capabilities/`:
- `algorithm`: Currently mining algorithm name
- `hashrate`: Mining speed in MH (megahashes)
- `measure_profit` / `measure_profit_scarab`: Revenue in mBTC/24h and currency/24h
- `measure_cost` / `measure_cost_scarab`: Power cost in mBTC/24h and currency/24h
- `measure_profit_percent`: Net profitability percentage
- `meter_profit` / `meter_cost`: Cumulative revenue/costs
- `smart_mode`: Autopilot toggle
- `smart_mode_min_profitability`: Minimum net profitability threshold (0-100%)
- `power_mode`: LOW/MEDIUM/HIGH power mode
- `measure_tariff_limit`: Learned tariff limit for Autopilot

### Hash Rate Normalization

All mining speeds are normalized to MH (megahashes) in `device.ts:112-152`. Handles various units from H to EH with humorous comments for each tier.

### Flow Cards

**Triggers**:
- `rig_status_changed`: When any rig changes mining status
- `you_suffer`: Bitcoin price changed by threshold percentage (Gilfoyle reference)
- `status_changed`: Per-device status change

**Actions**:
- `set_tariff_power`: Configure electricity cost per kWh
- `set_tariff_power_currency`: Set currency for tariff (e.g., USD, EUR)
- `set_power_mode`: Change rig power mode (LOW/MEDIUM/HIGH)
- `set_smart_mode`: Enable/disable Autopilot
- `set_smart_mode_min_profitability`: Set minimum profitability threshold

## Configuration

App settings (accessed via `this.homey.settings`):
- `nicehash_apiKey`, `nicehash_apiSecret`, `nicehash_orgId`: NiceHash API credentials
- `nicehash_locale`: Locale for API requests (default: 'en')
- `tariff`: Power cost per kWh in configured currency
- `tariff_currency`: Currency code (default: 'USD')
- `gilfoyle_threshold`: Percentage change for BTC price trigger (default: 5%)

Device settings (per rig):
- `smart_mode_min_profitability`: Minimum net profitability percentage (0-100%, default: 0)

## Important Implementation Notes

### Currency Display ("Scarab")
The app uses "¤" (generic currency symbol) in UI and "_scarab" suffix in capability names for currency-denominated values. This avoids hardcoding specific currency symbols while allowing users to configure their currency.

### Time Synchronization
NiceHash API requires accurate time synchronization. The API client calls `getTime()` on init to calculate `localTimeDiff` offset, which is added to all subsequent requests.

### Algorithm Lookup for V4 Devices
V4 devices return algorithm IDs instead of names. The device fetches the algorithms list hourly (`getAlgorithmsTimer`) and maintains a lookup array indexed by algorithm order.

### Error Handling Pattern
Most async operations use `.catch(this.error)` or `.catch((err) => { console.log(err.message) })` to prevent unhandled promise rejections. Failures are logged but generally don't crash the app.

### Store vs Capability Values
- **Store values**: Persistent device data not exposed to UI (e.g., `mining` flag, internal meters)
- **Capability values**: Exposed to Homey UI and flow cards (e.g., `measure_profit`, `onoff`)

The dashboard aggregates from store values (`rig.getStoreValue(metric)`) rather than capabilities for internal consistency.

## Testing Locally

The app requires valid NiceHash API credentials and active mining rigs to function. For development:
1. Obtain API key, secret, and organization ID from NiceHash account
2. Configure via Homey app settings after installation
3. Pair rig devices through the device pairing flow
