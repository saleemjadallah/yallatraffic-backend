const express = require('express');
const tomtom = require('../utils/tomtom');
const { getOrFetch } = require('../utils/cache');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/geocoding/reverse
 * Convert coordinates to address
 * Query params: lat, lng
 */
router.get('/reverse', async (req, res) => {
  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    // Round coordinates for better cache hits (about 11m precision)
    const roundedLat = parseFloat(lat).toFixed(4);
    const roundedLng = parseFloat(lng).toFixed(4);
    const cacheKey = `reverse:${roundedLat}:${roundedLng}`;

    const { data, cached } = await getOrFetch('geocoding', cacheKey, async () => {
      const response = await tomtom.get(
        `/search/2/reverseGeocode/${lat},${lng}.json`,
        {
          params: {
            language: 'en-US',
            returnSpeedLimit: false,
            returnRoadUse: false,
          },
        }
      );

      const address = response.data.addresses?.[0]?.address;
      if (!address) {
        return { address: null };
      }

      return {
        address: {
          freeformAddress: address.freeformAddress,
          streetName: address.streetName,
          municipality: address.municipality,
          countrySubdivision: address.countrySubdivision,
          country: address.country,
          postalCode: address.postalCode,
        },
        position: {
          lat: parseFloat(lat),
          lng: parseFloat(lng),
        },
      };
    });

    res.json({
      ...data,
      _cached: cached,
    });
  } catch (error) {
    logger.error('Reverse geocoding error:', error.message);
    res.status(500).json({ error: error.message || 'Reverse geocoding failed' });
  }
});

/**
 * GET /api/geocoding/forward
 * Convert address to coordinates
 * Query params: address
 */
router.get('/forward', async (req, res) => {
  try {
    const { address } = req.query;

    if (!address || address.length < 3) {
      return res.status(400).json({ error: 'Address must be at least 3 characters' });
    }

    const cacheKey = `forward:${address.toLowerCase()}`;

    const { data, cached } = await getOrFetch('geocoding', cacheKey, async () => {
      const response = await tomtom.get('/search/2/geocode/.json', {
        params: {
          query: address,
          limit: 1,
          countrySet: 'AE',
          language: 'en-US',
        },
      });

      const result = response.data.results?.[0];
      if (!result) {
        return { location: null };
      }

      return {
        location: {
          position: result.position,
          address: result.address?.freeformAddress,
          type: result.type,
          confidence: result.score,
        },
      };
    });

    res.json({
      ...data,
      _cached: cached,
    });
  } catch (error) {
    logger.error('Forward geocoding error:', error.message);
    res.status(500).json({ error: error.message || 'Forward geocoding failed' });
  }
});

module.exports = router;
