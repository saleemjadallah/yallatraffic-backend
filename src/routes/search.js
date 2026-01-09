const express = require('express');
const tomtom = require('../utils/tomtom');
const { getOrFetch } = require('../utils/cache');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/search/places
 * Search for places by query
 * Query params:
 *   - query: Search text (required)
 *   - lat, lng: Bias results near this location (optional)
 *   - limit: Max results (default 50)
 *   - typeahead: Use typeahead mode for faster but less comprehensive results (default false)
 */
router.get('/places', async (req, res) => {
  try {
    const { query, lat, lng, limit = 50, typeahead = 'false' } = req.query;

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    // Parse typeahead as boolean (query params are strings)
    const useTypeahead = typeahead === 'true';

    // Include location and typeahead in cache key if provided
    const locationKey = lat && lng ? `${lat}:${lng}` : 'global';
    const cacheKey = `search:${query.toLowerCase()}:${locationKey}:${limit}:${useTypeahead}`;

    const { data, cached } = await getOrFetch('search', cacheKey, async () => {
      const params = {
        query,
        limit: Math.min(parseInt(limit), 100), // Allow up to 100 results for comprehensive search
        language: 'en-US',
        typeahead: useTypeahead, // false = comprehensive results including smaller POIs
        countrySet: 'AE', // Focus on UAE
      };

      // Bias results to location if provided
      if (lat && lng) {
        params.lat = lat;
        params.lon = lng;
        params.radius = 50000; // 50km radius
      }

      const response = await tomtom.get('/search/2/search/.json', { params });

      // Transform results to a cleaner format
      const places = response.data.results?.map((result) => ({
        id: result.id,
        name: result.poi?.name || result.address?.freeformAddress,
        address: result.address?.freeformAddress,
        position: result.position,
        category: result.poi?.categories?.[0] || 'address',
        distance: result.dist,
        type: result.type,
      }));

      return { places };
    });

    res.json({
      ...data,
      _cached: cached,
    });
  } catch (error) {
    logger.error('Search error:', error.message);
    res.status(500).json({ error: error.message || 'Search failed' });
  }
});

/**
 * GET /api/search/autocomplete
 * Fast autocomplete suggestions
 * Query params:
 *   - query: Partial search text (required)
 *   - lat, lng: Bias results near this location (optional)
 */
router.get('/autocomplete', async (req, res) => {
  try {
    const { query, lat, lng } = req.query;

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const locationKey = lat && lng ? `${lat}:${lng}` : 'global';
    const cacheKey = `autocomplete:${query.toLowerCase()}:${locationKey}`;

    const { data, cached } = await getOrFetch('search', cacheKey, async () => {
      const params = {
        query,
        limit: 5,
        language: 'en-US',
        countrySet: 'AE',
      };

      if (lat && lng) {
        params.lat = lat;
        params.lon = lng;
      }

      const response = await tomtom.get('/search/2/autocomplete/.json', { params });

      const suggestions = response.data.results?.map((result) => ({
        text: result.segments?.map((s) => s.value).join(''),
        type: result.type,
      }));

      return { suggestions };
    });

    res.json({
      ...data,
      _cached: cached,
    });
  } catch (error) {
    logger.error('Autocomplete error:', error.message);
    res.status(500).json({ error: error.message || 'Autocomplete failed' });
  }
});

/**
 * GET /api/search/nearby
 * Find places near a location by category
 * Query params:
 *   - lat, lng: Center point (required)
 *   - category: Category ID or name (optional)
 *   - radius: Search radius in meters (default 5000)
 */
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, category, radius = 5000 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const cacheKey = `nearby:${lat}:${lng}:${category || 'all'}:${radius}`;

    const { data, cached } = await getOrFetch('search', cacheKey, async () => {
      const params = {
        lat,
        lon: lng,
        radius: Math.min(parseInt(radius), 50000),
        limit: 20,
        language: 'en-US',
      };

      if (category) {
        params.categorySet = category;
      }

      const response = await tomtom.get('/search/2/nearbySearch/.json', { params });

      const places = response.data.results?.map((result) => ({
        id: result.id,
        name: result.poi?.name || result.address?.freeformAddress,
        address: result.address?.freeformAddress,
        position: result.position,
        category: result.poi?.categories?.[0],
        distance: result.dist,
      }));

      return { places };
    });

    res.json({
      ...data,
      _cached: cached,
    });
  } catch (error) {
    logger.error('Nearby search error:', error.message);
    res.status(500).json({ error: error.message || 'Nearby search failed' });
  }
});

module.exports = router;
