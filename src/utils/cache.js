const NodeCache = require('node-cache');

// Cache with different TTLs for different data types
const caches = {
  // Traffic flow data - short TTL (30 seconds)
  traffic: new NodeCache({ stdTTL: 30, checkperiod: 60 }),

  // Incidents - medium TTL (2 minutes)
  incidents: new NodeCache({ stdTTL: 120, checkperiod: 120 }),

  // Routes - medium TTL (1 minute)
  routes: new NodeCache({ stdTTL: 60, checkperiod: 120 }),

  // Search results - longer TTL (10 minutes)
  search: new NodeCache({ stdTTL: 600, checkperiod: 300 }),

  // Geocoding - long TTL (1 hour)
  geocoding: new NodeCache({ stdTTL: 3600, checkperiod: 600 }),
};

/**
 * Get or fetch data with caching
 * @param {string} cacheType - Type of cache to use
 * @param {string} key - Cache key
 * @param {Function} fetchFn - Async function to fetch data if not cached
 * @returns {Promise<any>} Cached or freshly fetched data
 */
async function getOrFetch(cacheType, key, fetchFn) {
  const cache = caches[cacheType];
  if (!cache) {
    throw new Error(`Unknown cache type: ${cacheType}`);
  }

  const cached = cache.get(key);
  if (cached !== undefined) {
    return { data: cached, cached: true };
  }

  const data = await fetchFn();
  cache.set(key, data);
  return { data, cached: false };
}

/**
 * Clear a specific cache or all caches
 * @param {string} [cacheType] - Optional cache type to clear
 */
function clearCache(cacheType) {
  if (cacheType) {
    caches[cacheType]?.flushAll();
  } else {
    Object.values(caches).forEach((cache) => cache.flushAll());
  }
}

/**
 * Get cache statistics
 */
function getStats() {
  const stats = {};
  for (const [name, cache] of Object.entries(caches)) {
    stats[name] = cache.getStats();
  }
  return stats;
}

module.exports = {
  caches,
  getOrFetch,
  clearCache,
  getStats,
};
