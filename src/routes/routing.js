const express = require('express');
const tomtom = require('../utils/tomtom');
const { getOrFetch } = require('../utils/cache');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/routing/route
 * Calculate route between two points
 * Query params:
 *   - originLat, originLng: Starting point
 *   - destLat, destLng: Destination
 *   - departAt: Optional departure time (ISO 8601)
 *   - alternatives: Number of alternative routes (0-5, default 3)
 *   - traffic: Include traffic (default true)
 */
router.get('/route', async (req, res) => {
  try {
    const {
      originLat,
      originLng,
      destLat,
      destLng,
      departAt,
      alternatives = 3,
      traffic = 'true',
    } = req.query;

    if (!originLat || !originLng || !destLat || !destLng) {
      return res.status(400).json({
        error: 'Origin and destination coordinates required',
      });
    }

    // Create cache key (without departAt for "now" routes to enable caching)
    const isNow = !departAt;
    const cacheKey = isNow
      ? `route:${originLat}:${originLng}:${destLat}:${destLng}:${alternatives}`
      : null;

    const fetchRoute = async () => {
      const params = {
        routeType: 'fastest',
        traffic: traffic === 'true',
        travelMode: 'car',
        maxAlternatives: Math.min(parseInt(alternatives), 5),
        computeTravelTimeFor: 'all',
        sectionType: 'traffic',
        report: 'effectiveSettings',
      };

      if (departAt) {
        params.departAt = departAt;
      }

      const response = await tomtom.get(
        `/routing/1/calculateRoute/${originLat},${originLng}:${destLat},${destLng}/json`,
        { params }
      );

      return response.data;
    };

    let result;
    if (cacheKey) {
      result = await getOrFetch('routes', cacheKey, fetchRoute);
    } else {
      result = { data: await fetchRoute(), cached: false };
    }

    res.json({
      ...result.data,
      _cached: result.cached,
    });
  } catch (error) {
    logger.error('Routing error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to calculate route' });
  }
});

/**
 * POST /api/routing/batch
 * Calculate multiple routes at different departure times
 * Body: { origin: {lat, lng}, destination: {lat, lng}, departureTimes: [ISO strings] }
 */
router.post('/batch', async (req, res) => {
  try {
    const { origin, destination, departureTimes } = req.body;

    if (!origin || !destination || !departureTimes?.length) {
      return res.status(400).json({
        error: 'origin, destination, and departureTimes array required',
      });
    }

    if (departureTimes.length > 10) {
      return res.status(400).json({
        error: 'Maximum 10 departure times allowed per request',
      });
    }

    // Calculate routes for each departure time in parallel
    const routePromises = departureTimes.map(async (departAt) => {
      try {
        const response = await tomtom.get(
          `/routing/1/calculateRoute/${origin.lat},${origin.lng}:${destination.lat},${destination.lng}/json`,
          {
            params: {
              routeType: 'fastest',
              traffic: true,
              travelMode: 'car',
              departAt,
              computeTravelTimeFor: 'all',
            },
          }
        );

        const route = response.data.routes?.[0];
        return {
          departureTime: departAt,
          travelTimeSeconds: route?.summary?.travelTimeInSeconds,
          delaySeconds: route?.summary?.trafficDelayInSeconds || 0,
          lengthMeters: route?.summary?.lengthInMeters,
          arrivalTime: route?.summary?.arrivalTime,
        };
      } catch (error) {
        return {
          departureTime: departAt,
          error: error.message,
        };
      }
    });

    const results = await Promise.all(routePromises);

    // Find the best departure time
    const validResults = results.filter((r) => r.travelTimeSeconds);
    const best = validResults.reduce(
      (min, r) => (r.travelTimeSeconds < min.travelTimeSeconds ? r : min),
      validResults[0]
    );

    res.json({
      results: results.map((r) => ({
        ...r,
        isBest: r.departureTime === best?.departureTime,
      })),
      bestDepartureTime: best?.departureTime,
    });
  } catch (error) {
    logger.error('Batch routing error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to calculate routes' });
  }
});

module.exports = router;
