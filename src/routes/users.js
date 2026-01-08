const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/users/me
 * Get current user profile
 */
router.get('/me', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        preferences: true,
        savedPlaces: {
          orderBy: { updatedAt: 'desc' },
        },
        _count: {
          select: { trips: true, incidents: true },
        },
      },
    });

    res.json({ user });
  } catch (error) {
    logger.error('Get user error:', error.message);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

/**
 * PATCH /api/users/me
 * Update current user profile
 */
router.patch('/me', async (req, res) => {
  try {
    const { displayName, photoUrl } = req.body;

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(displayName !== undefined && { displayName }),
        ...(photoUrl !== undefined && { photoUrl }),
      },
    });

    res.json({ user });
  } catch (error) {
    logger.error('Update user error:', error.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * GET /api/users/me/preferences
 * Get user preferences
 */
router.get('/me/preferences', async (req, res) => {
  try {
    let preferences = await prisma.userPreferences.findUnique({
      where: { userId: req.user.id },
    });

    // Create default preferences if they don't exist
    if (!preferences) {
      preferences = await prisma.userPreferences.create({
        data: { userId: req.user.id },
      });
    }

    res.json({ preferences });
  } catch (error) {
    logger.error('Get preferences error:', error.message);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

/**
 * PATCH /api/users/me/preferences
 * Update user preferences
 */
router.patch('/me/preferences', async (req, res) => {
  try {
    const allowedFields = [
      'avoidTolls',
      'avoidHighways',
      'preferredRouteType',
      'departureAlerts',
      'trafficAlerts',
      'incidentAlerts',
      'weeklyDigest',
      'alertMinutesBefore',
      'distanceUnit',
      'timeFormat',
      'language',
    ];

    // Filter to only allowed fields
    const data = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        data[field] = req.body[field];
      }
    }

    const preferences = await prisma.userPreferences.upsert({
      where: { userId: req.user.id },
      update: data,
      create: { userId: req.user.id, ...data },
    });

    res.json({ preferences });
  } catch (error) {
    logger.error('Update preferences error:', error.message);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * GET /api/users/me/places
 * Get saved places
 */
router.get('/me/places', async (req, res) => {
  try {
    const places = await prisma.savedPlace.findMany({
      where: { userId: req.user.id },
      orderBy: [{ placeType: 'asc' }, { visitCount: 'desc' }],
    });

    res.json({ places });
  } catch (error) {
    logger.error('Get places error:', error.message);
    res.status(500).json({ error: 'Failed to get saved places' });
  }
});

/**
 * POST /api/users/me/places
 * Add a saved place
 */
router.post('/me/places', async (req, res) => {
  try {
    const { name, address, latitude, longitude, placeType, icon } = req.body;

    if (!name || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'name, latitude, and longitude are required' });
    }

    // For home/work, replace existing
    if (placeType === 'home' || placeType === 'work') {
      await prisma.savedPlace.deleteMany({
        where: { userId: req.user.id, placeType },
      });
    }

    const place = await prisma.savedPlace.create({
      data: {
        userId: req.user.id,
        name,
        address,
        latitude,
        longitude,
        placeType: placeType || 'other',
        icon,
      },
    });

    res.status(201).json({ place });
  } catch (error) {
    logger.error('Create place error:', error.message);
    res.status(500).json({ error: 'Failed to save place' });
  }
});

/**
 * DELETE /api/users/me/places/:id
 * Delete a saved place
 */
router.delete('/me/places/:id', async (req, res) => {
  try {
    const place = await prisma.savedPlace.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });

    if (!place) {
      return res.status(404).json({ error: 'Place not found' });
    }

    await prisma.savedPlace.delete({
      where: { id: req.params.id },
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete place error:', error.message);
    res.status(500).json({ error: 'Failed to delete place' });
  }
});

/**
 * POST /api/users/me/push-token
 * Register push notification token
 */
router.post('/me/push-token', async (req, res) => {
  try {
    const { token, platform, deviceId } = req.body;

    if (!token || !platform) {
      return res.status(400).json({ error: 'token and platform are required' });
    }

    if (!['ios', 'android'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be ios or android' });
    }

    // Upsert the token
    const pushToken = await prisma.pushToken.upsert({
      where: {
        userId_token: { userId: req.user.id, token },
      },
      update: {
        platform,
        deviceId,
        isActive: true,
        updatedAt: new Date(),
      },
      create: {
        userId: req.user.id,
        token,
        platform,
        deviceId,
      },
    });

    res.json({ pushToken });
  } catch (error) {
    logger.error('Push token error:', error.message);
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

/**
 * DELETE /api/users/me/push-token
 * Unregister push notification token
 */
router.delete('/me/push-token', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    await prisma.pushToken.updateMany({
      where: { userId: req.user.id, token },
      data: { isActive: false },
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Remove push token error:', error.message);
    res.status(500).json({ error: 'Failed to remove push token' });
  }
});

module.exports = router;
