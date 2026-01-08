const express = require('express');
const prisma = require('../utils/prisma');
const logger = require('../utils/logger');

const router = express.Router();

// Vibe TTL in minutes
const VIBE_TTL_MINUTES = 7;
// Cooldown between submissions in seconds
const COOLDOWN_SECONDS = 30;
// Max vibes per 24 hours
const MAX_VIBES_PER_DAY = 20;

/**
 * Calculate geohash for a location (simplified version)
 * In production, use a proper geohash library
 */
function calculateGeohash(lat, lng, precision = 6) {
  // Simple grid-based approach for demo
  // In production, use ngeohash package
  const latGrid = Math.floor(lat * Math.pow(10, precision - 3));
  const lngGrid = Math.floor(lng * Math.pow(10, precision - 3));
  return `${latGrid}_${lngGrid}`;
}

/**
 * Calculate road segment ID from coordinates
 */
function calculateSegmentId(lat, lng) {
  // Round to ~100m precision for segment grouping
  const latRound = Math.round(lat * 1000) / 1000;
  const lngRound = Math.round(lng * 1000) / 1000;
  return `seg_${latRound}_${lngRound}`;
}

/**
 * GET /api/vibes/nearby
 * Get nearby vibe clusters
 */
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 5 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const radiusKm = parseFloat(radius);

    // Calculate geohash prefix for query
    const geohash = calculateGeohash(latitude, longitude, 4);

    // Get non-expired clusters
    const now = new Date();
    const clusters = await prisma.vibeCluster.findMany({
      where: {
        expiresAt: { gt: now },
        totalCount: { gt: 0 },
      },
      orderBy: { totalCount: 'desc' },
      take: 50,
    });

    // Filter by distance and format response
    const nearbyClusters = clusters
      .filter(cluster => {
        const distance = getDistanceKm(latitude, longitude, cluster.latitude, cluster.longitude);
        return distance <= radiusKm;
      })
      .map(cluster => ({
        segmentId: cluster.segmentId,
        lat: cluster.latitude,
        lng: cluster.longitude,
        geohash: cluster.geohash,
        vibes: {
          smooth: cluster.smoothCount,
          slowdown: cluster.slowdownCount,
          heavy: cluster.heavyCount,
          deadlock: cluster.deadlockCount,
          accident: cluster.accidentCount,
          police: cluster.policeCount,
          hazard: cluster.hazardCount,
        },
        totalCount: cluster.totalCount,
        dominantVibe: cluster.dominantVibe,
        lastUpdated: cluster.lastUpdated.toISOString(),
        expiresAt: cluster.expiresAt.toISOString(),
      }));

    res.json({ clusters: nearbyClusters });
  } catch (error) {
    logger.error('Get nearby vibes error:', error);
    res.status(500).json({ error: 'Failed to get nearby vibes' });
  }
});

/**
 * POST /api/vibes
 * Submit a new vibe
 */
router.post('/', async (req, res) => {
  try {
    const { type, lat, lng, userId } = req.body;

    if (!type || !lat || !lng || !userId) {
      return res.status(400).json({ error: 'type, lat, lng, and userId are required' });
    }

    const validTypes = ['smooth', 'slowdown', 'heavy', 'deadlock', 'accident', 'police', 'hazard'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid vibe type. Must be one of: ${validTypes.join(', ')}` });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    // Check rate limit
    const rateLimit = await checkRateLimit(userId);
    if (!rateLimit.canSubmit) {
      return res.status(429).json({
        error: rateLimit.reason,
        cooldownSeconds: rateLimit.cooldownSeconds,
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + VIBE_TTL_MINUTES * 60 * 1000);
    const geohash = calculateGeohash(latitude, longitude);
    const segmentId = calculateSegmentId(latitude, longitude);

    // Create the vibe
    await prisma.vibe.create({
      data: {
        anonymousId: userId,
        latitude,
        longitude,
        geohash,
        segmentId,
        type,
        expiresAt,
      },
    });

    // Update the cluster aggregate
    await updateVibeCluster(segmentId, latitude, longitude, geohash, type, expiresAt);

    // Update rate limit
    await updateRateLimit(userId);

    logger.info(`Vibe submitted: ${type} at ${segmentId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Submit vibe error:', error);
    res.status(500).json({ error: 'Failed to submit vibe' });
  }
});

/**
 * GET /api/vibes/rate-limit
 * Check rate limit for a user
 */
router.get('/rate-limit', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const result = await checkRateLimit(userId);
    res.json(result);
  } catch (error) {
    logger.error('Check rate limit error:', error);
    res.status(500).json({ error: 'Failed to check rate limit' });
  }
});

/**
 * GET /api/vibes/mine
 * Get user's recent vibes
 */
router.get('/mine', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const now = new Date();
    const vibes = await prisma.vibe.findMany({
      where: {
        anonymousId: userId,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    res.json({
      vibes: vibes.map(v => ({
        type: v.type,
        createdAt: v.createdAt.toISOString(),
        expiresAt: v.expiresAt.toISOString(),
      })),
    });
  } catch (error) {
    logger.error('Get user vibes error:', error);
    res.status(500).json({ error: 'Failed to get user vibes' });
  }
});

/**
 * Check rate limit for a user
 */
async function checkRateLimit(userId) {
  const rateLimit = await prisma.vibeRateLimit.findUnique({
    where: { anonymousId: userId },
  });

  if (!rateLimit) {
    return { canSubmit: true, reason: null, cooldownSeconds: null };
  }

  const now = new Date();

  // Check cooldown
  const timeSinceLastVibe = (now - rateLimit.lastVibeAt) / 1000;
  if (timeSinceLastVibe < COOLDOWN_SECONDS) {
    const remaining = Math.ceil(COOLDOWN_SECONDS - timeSinceLastVibe);
    return {
      canSubmit: false,
      reason: `Wait ${remaining} seconds before sharing again`,
      cooldownSeconds: remaining,
    };
  }

  // Check 24h limit (reset if past resetAt)
  if (now > rateLimit.resetAt) {
    return { canSubmit: true, reason: null, cooldownSeconds: null };
  }

  if (rateLimit.vibeCount24h >= MAX_VIBES_PER_DAY) {
    return {
      canSubmit: false,
      reason: `You've shared ${MAX_VIBES_PER_DAY} vibes today. Try again tomorrow!`,
      cooldownSeconds: null,
    };
  }

  return { canSubmit: true, reason: null, cooldownSeconds: null };
}

/**
 * Update rate limit after vibe submission
 */
async function updateRateLimit(userId) {
  const now = new Date();
  const resetAt = new Date(now);
  resetAt.setHours(resetAt.getHours() + 24);

  await prisma.vibeRateLimit.upsert({
    where: { anonymousId: userId },
    update: {
      lastVibeAt: now,
      vibeCount24h: { increment: 1 },
    },
    create: {
      anonymousId: userId,
      lastVibeAt: now,
      vibeCount24h: 1,
      resetAt,
    },
  });
}

/**
 * Update vibe cluster aggregate
 */
async function updateVibeCluster(segmentId, lat, lng, geohash, type, expiresAt) {
  const countField = `${type}Count`;

  // Try to update existing cluster
  const existing = await prisma.vibeCluster.findUnique({
    where: { segmentId },
  });

  if (existing) {
    // Get current counts
    const counts = {
      smooth: existing.smoothCount,
      slowdown: existing.slowdownCount,
      heavy: existing.heavyCount,
      deadlock: existing.deadlockCount,
      accident: existing.accidentCount,
      police: existing.policeCount,
      hazard: existing.hazardCount,
    };
    counts[type]++;

    // Find dominant vibe
    let dominant = 'smooth';
    let maxCount = 0;
    for (const [vibeType, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        dominant = vibeType;
      }
    }

    await prisma.vibeCluster.update({
      where: { segmentId },
      data: {
        [countField]: { increment: 1 },
        totalCount: { increment: 1 },
        dominantVibe: dominant,
        lastUpdated: new Date(),
        expiresAt: expiresAt > existing.expiresAt ? expiresAt : existing.expiresAt,
      },
    });
  } else {
    // Create new cluster
    const data = {
      segmentId,
      latitude: lat,
      longitude: lng,
      geohash,
      totalCount: 1,
      dominantVibe: type,
      expiresAt,
    };
    data[countField] = 1;

    await prisma.vibeCluster.create({ data });
  }
}

/**
 * Calculate distance between two points in km (Haversine formula)
 */
function getDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

module.exports = router;
