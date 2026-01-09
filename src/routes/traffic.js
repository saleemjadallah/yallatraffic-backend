const express = require('express');
const tomtom = require('../utils/tomtom');
const { getOrFetch, caches } = require('../utils/cache');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Get English road name for a location via reverse geocoding
 * Uses aggressive caching since road names rarely change
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Promise<string|null>} English road name or null
 */
async function getEnglishRoadName(lat, lng) {
  // Round to 4 decimal places (~11m precision) for cache efficiency
  const roundedLat = parseFloat(lat).toFixed(4);
  const roundedLng = parseFloat(lng).toFixed(4);
  const cacheKey = `road:${roundedLat}:${roundedLng}`;

  // Check cache first
  const cached = caches.roadNames.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
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
    const roadName = address?.streetName || address?.street || null;

    // Cache the result (even null to avoid repeated lookups)
    caches.roadNames.set(cacheKey, roadName);
    return roadName;
  } catch (error) {
    logger.warn('Road name lookup failed:', { lat, lng, error: error.message });
    // Cache null to avoid hammering API on repeated failures
    caches.roadNames.set(cacheKey, null);
    return null;
  }
}

/**
 * Enrich incidents with English road names
 * Processes in parallel with concurrency limit
 * @param {Array} incidents - Array of incident objects
 * @returns {Promise<Array>} Enriched incidents
 */
async function enrichIncidentsWithRoadNames(incidents) {
  if (!incidents || incidents.length === 0) return incidents;

  // Process in batches of 5 to avoid overwhelming the API
  const BATCH_SIZE = 5;
  const enrichedIncidents = [...incidents];

  for (let i = 0; i < enrichedIncidents.length; i += BATCH_SIZE) {
    const batch = enrichedIncidents.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (incident, batchIndex) => {
        const geometry = incident.geometry;
        if (!geometry) return;

        // Get coordinates from geometry
        let lat, lng;
        if (geometry.type === 'Point') {
          lng = geometry.coordinates[0];
          lat = geometry.coordinates[1];
        } else if (geometry.type === 'LineString' && geometry.coordinates.length > 0) {
          // Use midpoint for line strings
          const midIndex = Math.floor(geometry.coordinates.length / 2);
          lng = geometry.coordinates[midIndex][0];
          lat = geometry.coordinates[midIndex][1];
        }

        if (lat && lng) {
          const englishRoadName = await getEnglishRoadName(lat, lng);
          if (englishRoadName) {
            const actualIndex = i + batchIndex;
            enrichedIncidents[actualIndex] = {
              ...enrichedIncidents[actualIndex],
              properties: {
                ...enrichedIncidents[actualIndex].properties,
                roadNameEn: englishRoadName,
              },
            };
          }
        }
      })
    );
  }

  return enrichedIncidents;
}

/**
 * GET /api/traffic/flow
 * Get traffic flow data for a location
 * Query params: lat, lng, zoom (optional, default 10)
 */
router.get('/flow', async (req, res) => {
  try {
    const { lat, lng, zoom = 10 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const cacheKey = `flow:${lat}:${lng}:${zoom}`;

    const { data, cached } = await getOrFetch('traffic', cacheKey, async () => {
      const response = await tomtom.get(
        `/traffic/services/4/flowSegmentData/relative0/${zoom}/json`,
        {
          params: {
            point: `${lat},${lng}`,
            unit: 'KMPH',
          },
        }
      );
      return response.data;
    });

    res.json({
      ...data,
      _cached: cached,
    });
  } catch (error) {
    logger.error('Traffic flow error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch traffic flow' });
  }
});

/**
 * GET /api/traffic/incidents
 * Get traffic incidents in a bounding box
 * Query params: minLat, minLng, maxLat, maxLng
 */
router.get('/incidents', async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;

    if (!minLat || !minLng || !maxLat || !maxLng) {
      return res.status(400).json({
        error: 'Bounding box required: minLat, minLng, maxLat, maxLng',
      });
    }

    const cacheKey = `incidents:${minLat}:${minLng}:${maxLat}:${maxLng}`;

    const { data, cached } = await getOrFetch('incidents', cacheKey, async () => {
      const response = await tomtom.get('/traffic/services/5/incidentDetails', {
        params: {
          bbox: `${minLng},${minLat},${maxLng},${maxLat}`,
          fields:
            '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,aci{probabilityOfOccurrence,numberOfReports,lastReportTime}}}}',
          language: 'en-GB',
          categoryFilter: '0,1,2,3,4,5,6,7,8,9,10,11,14',
          timeValidityFilter: 'present',
        },
      });
      return response.data;
    });

    // Enrich incidents with English road names (uses separate cache)
    // Only enrich if we have incidents and this is a fresh fetch or forced
    let enrichedData = data;
    if (data.incidents && data.incidents.length > 0) {
      try {
        const enrichedIncidents = await enrichIncidentsWithRoadNames(data.incidents);
        enrichedData = { ...data, incidents: enrichedIncidents };
      } catch (enrichError) {
        // Log but don't fail - return original data if enrichment fails
        logger.warn('Incident enrichment failed:', enrichError.message);
      }
    }

    res.json({
      ...enrichedData,
      _cached: cached,
    });
  } catch (error) {
    logger.error('Traffic incidents error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch incidents' });
  }
});

/**
 * GET /api/traffic/tile/:z/:x/:y
 * Get traffic flow tile (for map overlay)
 */
router.get('/tile/:z/:x/:y', async (req, res) => {
  try {
    const { z, x, y } = req.params;
    const { style = 'relative0' } = req.query;

    const response = await tomtom.get(
      `/traffic/map/4/tile/flow/${style}/${z}/${x}/${y}.png`,
      {
        responseType: 'arraybuffer',
        params: {
          thickness: 10,
          tileSize: 256,
        },
      }
    );

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=30');
    res.send(response.data);
  } catch (error) {
    logger.error('Traffic tile error:', error.message);
    res.status(500).json({ error: 'Failed to fetch traffic tile' });
  }
});

module.exports = router;
