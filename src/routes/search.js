const express = require('express');
const googlePlaces = require('../utils/googlePlaces');
const tomtom = require('../utils/tomtom');
const { getOrFetch } = require('../utils/cache');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/search/places
 * Search for places by query using Google Places API
 * Query params:
 *   - query: Search text (required)
 *   - lat, lng: Bias results near this location (optional)
 *   - limit: Max results (default 20)
 */
router.get('/places', async (req, res) => {
  try {
    const { query, lat, lng, limit = 20 } = req.query;

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    // Include location in cache key if provided
    const locationKey = lat && lng ? `${parseFloat(lat).toFixed(3)}:${parseFloat(lng).toFixed(3)}` : 'global';
    const cacheKey = `google:search:${query.toLowerCase()}:${locationKey}:${limit}`;

    const { data, cached } = await getOrFetch('search', cacheKey, async () => {
      const places = await googlePlaces.searchPlaces(query, {
        lat,
        lng,
        limit: Math.min(parseInt(limit), 20),
        radius: 50000, // 50km radius for UAE coverage
      });

      // Transform to our standard format
      const transformedPlaces = places.map(googlePlaces.transformPlace);

      return { places: transformedPlaces };
    });

    res.json({
      ...data,
      _cached: cached,
      _source: 'google',
    });
  } catch (error) {
    logger.error('Google Places search error:', error.message);

    // Fallback to TomTom if Google fails
    try {
      logger.info('Falling back to TomTom search');
      const { query, lat, lng, limit = 20 } = req.query;

      const params = {
        query,
        limit: Math.min(parseInt(limit), 20),
        language: 'en-US',
        typeahead: false,
        countrySet: 'AE',
      };

      if (lat && lng) {
        params.lat = lat;
        params.lon = lng;
        params.radius = 50000;
      }

      const response = await tomtom.get('/search/2/search/.json', { params });

      const places = response.data.results?.map((result) => ({
        id: result.id,
        name: result.poi?.name || result.address?.freeformAddress,
        address: result.address?.freeformAddress,
        position: result.position,
        category: result.poi?.categories?.[0] || 'address',
        distance: result.dist,
        type: result.type,
        source: 'tomtom',
      }));

      res.json({ places, _source: 'tomtom_fallback' });
    } catch (fallbackError) {
      logger.error('TomTom fallback also failed:', fallbackError.message);
      res.status(500).json({ error: error.message || 'Search failed' });
    }
  }
});

/**
 * GET /api/search/autocomplete
 * Fast autocomplete suggestions using Google Places API
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

    const locationKey = lat && lng ? `${parseFloat(lat).toFixed(3)}:${parseFloat(lng).toFixed(3)}` : 'global';
    const cacheKey = `google:autocomplete:${query.toLowerCase()}:${locationKey}`;

    const { data, cached } = await getOrFetch('search', cacheKey, async () => {
      const suggestions = await googlePlaces.autocomplete(query, { lat, lng });

      // Transform and filter valid suggestions
      const transformedSuggestions = suggestions
        .map(googlePlaces.transformSuggestion)
        .filter(Boolean);

      return { suggestions: transformedSuggestions };
    });

    res.json({
      ...data,
      _cached: cached,
      _source: 'google',
    });
  } catch (error) {
    logger.error('Google autocomplete error:', error.message);

    // Fallback to TomTom
    try {
      logger.info('Falling back to TomTom autocomplete');
      const { query, lat, lng } = req.query;

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

      res.json({ suggestions, _source: 'tomtom_fallback' });
    } catch (fallbackError) {
      logger.error('TomTom fallback also failed:', fallbackError.message);
      res.status(500).json({ error: error.message || 'Autocomplete failed' });
    }
  }
});

/**
 * GET /api/search/place/:placeId
 * Get place details by Google Place ID
 * Used when user selects an autocomplete suggestion
 */
router.get('/place/:placeId', async (req, res) => {
  try {
    const { placeId } = req.params;

    if (!placeId) {
      return res.status(400).json({ error: 'placeId is required' });
    }

    const cacheKey = `google:place:${placeId}`;

    const { data, cached } = await getOrFetch('search', cacheKey, async () => {
      const place = await googlePlaces.getPlaceDetails(placeId);
      return { place: googlePlaces.transformPlace(place) };
    });

    res.json({
      ...data,
      _cached: cached,
    });
  } catch (error) {
    logger.error('Place details error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to get place details' });
  }
});

/**
 * GET /api/search/nearby
 * Find places near a location by category
 * Still uses TomTom for category-based search (good for this use case)
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
        source: 'tomtom',
      }));

      return { places };
    });

    res.json({
      ...data,
      _cached: cached,
      _source: 'tomtom',
    });
  } catch (error) {
    logger.error('Nearby search error:', error.message);
    res.status(500).json({ error: error.message || 'Nearby search failed' });
  }
});

module.exports = router;
