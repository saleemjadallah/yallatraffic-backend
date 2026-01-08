const express = require('express');
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Default expiry times by incident type (in hours)
const EXPIRY_HOURS = {
  accident: 2,
  hazard: 4,
  police: 1,
  roadwork: 24,
  congestion: 1,
  other: 2,
};

/**
 * Hash IP address for anonymous voting
 */
function hashIp(ip) {
  return crypto.createHash('sha256').update(ip + process.env.IP_SALT || 'yalla').digest('hex').slice(0, 16);
}

/**
 * GET /api/incidents
 * Get active incidents in an area
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng, type } = req.query;

    if (!minLat || !minLng || !maxLat || !maxLng) {
      return res.status(400).json({ error: 'Bounding box required: minLat, minLng, maxLat, maxLng' });
    }

    const where = {
      isActive: true,
      expiresAt: { gt: new Date() },
      latitude: { gte: parseFloat(minLat), lte: parseFloat(maxLat) },
      longitude: { gte: parseFloat(minLng), lte: parseFloat(maxLng) },
    };

    if (type) {
      where.type = type;
    }

    const incidents = await prisma.incident.findMany({
      where,
      orderBy: { reportedAt: 'desc' },
      include: {
        reporter: {
          select: { displayName: true },
        },
        _count: {
          select: { votes: true },
        },
      },
    });

    // Transform response
    const transformed = incidents.map((incident) => ({
      id: incident.id,
      type: incident.type,
      severity: incident.severity,
      description: incident.description,
      latitude: incident.latitude,
      longitude: incident.longitude,
      roadName: incident.roadName,
      confirmations: incident.confirmations,
      denials: incident.denials,
      isVerified: incident.isVerified,
      reportedAt: incident.reportedAt,
      expiresAt: incident.expiresAt,
      reportedBy: incident.reporter?.displayName || 'Anonymous',
    }));

    res.json({ incidents: transformed });
  } catch (error) {
    logger.error('Get incidents error:', error.message);
    res.status(500).json({ error: 'Failed to get incidents' });
  }
});

/**
 * POST /api/incidents
 * Report a new incident (auth optional)
 */
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { latitude, longitude, roadName, type, severity, description } = req.body;

    if (!latitude || !longitude || !type) {
      return res.status(400).json({ error: 'latitude, longitude, and type are required' });
    }

    const validTypes = ['accident', 'hazard', 'police', 'roadwork', 'congestion', 'other'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
    }

    // Calculate expiry time
    const expiryHours = EXPIRY_HOURS[type] || 2;
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    const incident = await prisma.incident.create({
      data: {
        reportedBy: req.user?.id || null,
        latitude,
        longitude,
        roadName,
        type,
        severity: severity || 'moderate',
        description,
        expiresAt,
      },
    });

    res.status(201).json({ incident });
  } catch (error) {
    logger.error('Create incident error:', error.message);
    res.status(500).json({ error: 'Failed to report incident' });
  }
});

/**
 * POST /api/incidents/:id/vote
 * Vote on an incident (confirm/deny)
 */
router.post('/:id/vote', optionalAuth, async (req, res) => {
  try {
    const { voteType } = req.body;

    if (!voteType || !['confirm', 'deny'].includes(voteType)) {
      return res.status(400).json({ error: 'voteType must be confirm or deny' });
    }

    const incident = await prisma.incident.findUnique({
      where: { id: req.params.id },
    });

    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    if (!incident.isActive) {
      return res.status(400).json({ error: 'Incident is no longer active' });
    }

    // Get voter identifier (user ID or hashed IP)
    const voterIp = req.user?.id || hashIp(req.ip || req.headers['x-forwarded-for'] || 'unknown');

    // Check if already voted
    const existingVote = await prisma.incidentVote.findFirst({
      where: { incidentId: req.params.id, voterIp },
    });

    if (existingVote) {
      // Update existing vote
      if (existingVote.voteType !== voteType) {
        await prisma.incidentVote.update({
          where: { id: existingVote.id },
          data: { voteType },
        });

        // Update counts
        const updateData = voteType === 'confirm'
          ? { confirmations: { increment: 1 }, denials: { decrement: 1 } }
          : { confirmations: { decrement: 1 }, denials: { increment: 1 } };

        await prisma.incident.update({
          where: { id: req.params.id },
          data: updateData,
        });
      }
    } else {
      // Create new vote
      await prisma.incidentVote.create({
        data: {
          incidentId: req.params.id,
          voterIp,
          voteType,
        },
      });

      // Update counts
      const updateData = voteType === 'confirm'
        ? { confirmations: { increment: 1 } }
        : { denials: { increment: 1 } };

      await prisma.incident.update({
        where: { id: req.params.id },
        data: updateData,
      });
    }

    // Check verification status
    const updatedIncident = await prisma.incident.findUnique({
      where: { id: req.params.id },
    });

    // Auto-verify if enough confirmations (3+) and confirmations > denials
    if (
      updatedIncident.confirmations >= 3 &&
      updatedIncident.confirmations > updatedIncident.denials * 2 &&
      !updatedIncident.isVerified
    ) {
      await prisma.incident.update({
        where: { id: req.params.id },
        data: { isVerified: true },
      });
    }

    // Auto-resolve if too many denials
    if (updatedIncident.denials >= 3 && updatedIncident.denials > updatedIncident.confirmations * 2) {
      await prisma.incident.update({
        where: { id: req.params.id },
        data: { isActive: false, resolvedAt: new Date() },
      });
    }

    res.json({ success: true, voteType });
  } catch (error) {
    logger.error('Vote error:', error.message);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

/**
 * POST /api/incidents/:id/resolve
 * Mark incident as resolved (reporter only)
 */
router.post('/:id/resolve', requireAuth, async (req, res) => {
  try {
    const incident = await prisma.incident.findUnique({
      where: { id: req.params.id },
    });

    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    // Only the reporter can resolve
    if (incident.reportedBy !== req.user.id) {
      return res.status(403).json({ error: 'Only the reporter can resolve this incident' });
    }

    await prisma.incident.update({
      where: { id: req.params.id },
      data: {
        isActive: false,
        resolvedAt: new Date(),
      },
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Resolve incident error:', error.message);
    res.status(500).json({ error: 'Failed to resolve incident' });
  }
});

/**
 * GET /api/incidents/my
 * Get incidents reported by current user
 */
router.get('/my', requireAuth, async (req, res) => {
  try {
    const incidents = await prisma.incident.findMany({
      where: { reportedBy: req.user.id },
      orderBy: { reportedAt: 'desc' },
    });

    res.json({ incidents });
  } catch (error) {
    logger.error('Get my incidents error:', error.message);
    res.status(500).json({ error: 'Failed to get your incidents' });
  }
});

module.exports = router;
