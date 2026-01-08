const express = require('express');
const tomtom = require('../utils/tomtom');
const { getOrFetch } = require('../utils/cache');
const logger = require('../utils/logger');

const router = express.Router();

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

    res.json({
      ...data,
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
