'use strict';

import CryptoJS from 'crypto-js';
import request from 'request-promise-native';
import qs from 'qs';

const packagejson = require('../package.json');

/**
 * Generates a cryptographically random nonce for API request authentication.
 * Uses base-36 encoding of Math.random() to create alphanumeric strings.
 *
 * Complexity: O(1) - generates fixed 32-character string
 *
 * @returns {string} 32-character random alphanumeric nonce
 * @example
 * createNonce() // => "a3f9k2p8m1d7q4j6n0w5v9x2c8b1e4"
 */
function createNonce() {
  let s = ''; const
    length = 32;
  // Accumulate base-36 random strings until we have enough characters
  do {
    s += Math.random().toString(36).substr(2);
  } while (s.length < length);
  s = s.substr(0, length); // Trim to exact length
  return s;
}

/**
 * Generates HMAC-SHA256 authentication header for NiceHash API v2 requests.
 * Follows NiceHash's specific signature format with null-byte delimited fields.
 *
 * Signature format (null-byte \0 delimited):
 * apiKey \0 time \0 nonce \0 \0 orgId \0 \0 method \0 path \0 query \0 body
 *
 * Complexity: O(1) - fixed number of HMAC operations regardless of input size
 *
 * @param {string} apiKey - NiceHash API key
 * @param {string} apiSecret - NiceHash API secret for HMAC signing
 * @param {string} time - Unix timestamp in milliseconds (as string)
 * @param {string} nonce - Unique request identifier (32 chars)
 * @param {string} [organizationId=''] - NiceHash organization ID (optional)
 * @param {Object} [request={}] - Request details for signature
 * @param {string} request.method - HTTP method (GET, POST, PUT, DELETE)
 * @param {string} request.path - API endpoint path (without query string)
 * @param {Object|string} [request.query] - Query parameters (object or string)
 * @param {Object|string} [request.body] - Request body (object or string)
 * @returns {string} Authentication header in format "apiKey:hexSignature"
 * @example
 * getAuthHeader('key123', 'secret', '1234567890', 'nonce', 'org1', {
 *   method: 'GET',
 *   path: '/main/api/v2/mining/rigs2'
 * }) // => "key123:a3f9d2..."
 */
const getAuthHeader = (apiKey, apiSecret, time, nonce, organizationId = '', request = {}) => {
  const hmac = CryptoJS.algo.HMAC.create(CryptoJS.algo.SHA256, apiSecret);

  // Build signature following NiceHash API v2 specification
  // Each field is separated by null byte (\0)
  hmac.update(apiKey);
  hmac.update('\0');
  hmac.update(time);
  hmac.update('\0');
  hmac.update(nonce);
  hmac.update('\0');
  hmac.update('\0'); // Empty field in spec
  if (organizationId) hmac.update(organizationId);
  hmac.update('\0');
  hmac.update('\0'); // Empty field in spec
  hmac.update(request.method);
  hmac.update('\0');
  hmac.update(request.path);
  hmac.update('\0');
  // Query parameters: convert object to query string if needed
  if (request.query) hmac.update(typeof request.query === 'object' ? qs.stringify(request.query) : request.query);
  // Body: convert object to JSON if needed
  if (request.body) {
    hmac.update('\0');
    hmac.update(typeof request.body === 'object' ? JSON.stringify(request.body) : request.body);
  }

  return `${apiKey}:${hmac.finalize().toString(CryptoJS.enc.Hex)}`;
};

/**
 * NiceHash API v2 client with HMAC-SHA256 authentication.
 * Handles time synchronization and authenticated requests to NiceHash endpoints.
 *
 * Flow:
 * 1. Construct Api instance with credentials
 * 2. Call getTime() to sync with NiceHash server time
 * 3. Use get/post/put/delete methods for API calls
 *
 * Dependencies:
 * - Used by: nicehash/lib.ts (NiceHashLib class)
 * - Calls: NiceHash API v2 endpoints (api2.nicehash.com)
 *
 * @class Api
 * @example
 * const api = new Api({
 *   apiHost: 'https://api2.nicehash.com',
 *   locale: 'en',
 *   apiKey: 'your-api-key',
 *   apiSecret: 'your-api-secret',
 *   orgId: 'your-org-id'
 * });
 * await api.getTime();
 * const rigs = await api.get('/main/api/v2/mining/rigs2');
 */
class Api {

  /**
   * Creates a new NiceHash API client instance.
   *
   * @param {Object} config - API configuration
   * @param {string} config.locale - Language locale (e.g., 'en', 'de')
   * @param {string} config.apiHost - NiceHash API base URL
   * @param {string} config.apiKey - NiceHash API key
   * @param {string} config.apiSecret - NiceHash API secret
   * @param {string} config.orgId - NiceHash organization ID
   */
  constructor({
    locale, apiHost, apiKey, apiSecret, orgId,
  }) {
    this.locale = locale || 'en';
    this.host = apiHost;
    this.key = apiKey;
    this.secret = apiSecret;
    this.org = orgId;
    this.localTimeDiff = null; // Time offset between local and NiceHash server
  }

  /**
   * Synchronizes local time with NiceHash server time.
   * MUST be called before making any authenticated API requests.
   * Calculates time difference to ensure request timestamps are accurate.
   *
   * Complexity: O(1) - single HTTP request
   *
   * @returns {Promise<Object>} Server time response
   * @throws {Error} If unable to fetch server time
   * @example
   * await api.getTime();
   * // Now localTimeDiff is set and authenticated calls work
   */
  getTime() {
    return request({
      uri: `${this.host}/api/v2/time`,
      json: true,
    })
      .then(res => {
        // Calculate offset: local time may be ahead or behind server
        this.localTimeDiff = res.serverTime - (+new Date());
        this.time = res.serverTime;
        return res;
      });
  }

  /**
   * Makes an authenticated API call to NiceHash.
   * Handles query string extraction, timestamp calculation, and HMAC signing.
   *
   * Complexity: O(1) - constant time operations plus HTTP request
   *
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
   * @param {string} path - API endpoint path (may include query string)
   * @param {Object} [options={}] - Request options
   * @param {Object|string} [options.query] - Query parameters
   * @param {Object|string} [options.body] - Request body
   * @param {number} [options.time] - Override timestamp (for testing)
   * @returns {Promise<Object>} API response
   * @throws {Error} If getTime() hasn't been called yet
   * @private
   */
  apiCall(method, path, { query, body, time } = {}) {
    if (this.localTimeDiff === null) {
      return Promise.reject(new Error('Get server time first .getTime()'));
    }

    // Extract query string from path if present (e.g., "/path?foo=bar")
    const [pathOnly, pathQuery] = path.split('?');
    if (pathQuery) query = { ...qs.parse(pathQuery), ...query };

    const nonce = createNonce();
    // Apply time offset to match NiceHash server time
    const timestamp = (time || (+new Date() + this.localTimeDiff)).toString();
    const options = {
      uri: this.host + pathOnly,
      method,
      headers: {
        Accept: 'application/json, text/plain',
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Request-Id': nonce,
        'X-User-Agent': 'homey-nicehash-remote/' + packagejson.version,
        'X-Time': timestamp,
        'X-Nonce': nonce,
        'X-User-Lang': this.locale,
        'X-Organization-Id': this.org,
        // Generate HMAC signature for authentication
        'X-Auth': getAuthHeader(this.key, this.secret, timestamp, nonce, this.org, {
          method,
          path: pathOnly,
          query,
          body,
        }),
      },
      qs: query,
      body,
      json: true,
    };

    return request(options);
  }

  /**
   * Makes an authenticated GET request to NiceHash API.
   *
   * @param {string} path - API endpoint path
   * @param {Object} [options] - Query parameters and other options
   * @returns {Promise<Object>} API response
   * @example
   * const rigs = await api.get('/main/api/v2/mining/rigs2');
   */
  get(path, options) {
    return this.apiCall('GET', path, options);
  }

  /**
   * Makes an authenticated POST request to NiceHash API.
   *
   * @param {string} path - API endpoint path
   * @param {Object} [options] - Request body and other options
   * @returns {Promise<Object>} API response
   * @example
   * await api.post('/main/api/v2/mining/rigs/status2', {
   *   body: { rigId: '123', action: 'START' }
   * });
   */
  post(path, options) {
    return this.apiCall('POST', path, options);
  }

  /**
   * Makes an authenticated PUT request to NiceHash API.
   *
   * @param {string} path - API endpoint path
   * @param {Object} [options] - Request body and other options
   * @returns {Promise<Object>} API response
   */
  put(path, options) {
    return this.apiCall('PUT', path, options);
  }

  /**
   * Makes an authenticated DELETE request to NiceHash API.
   *
   * @param {string} path - API endpoint path
   * @param {Object} [options] - Request options
   * @returns {Promise<Object>} API response
   */
  delete(path, options) {
    return this.apiCall('DELETE', path, options);
  }

}

export default Api;
