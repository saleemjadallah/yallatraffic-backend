const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/trips
 * Get trip history with pagination
 */
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, startDate, endDate } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = { userId: req.user.id };

    // Date filters
    if (startDate || endDate) {
      where.departureTime = {};
      if (startDate) where.departureTime.gte = new Date(startDate);
      if (endDate) where.departureTime.lte = new Date(endDate);
    }

    const [trips, total] = await Promise.all([
      prisma.trip.findMany({
        where,
        orderBy: { departureTime: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.trip.count({ where }),
    ]);

    res.json({
      trips,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    logger.error('Get trips error:', error.message);
    res.status(500).json({ error: 'Failed to get trip history' });
  }
});

/**
 * POST /api/trips
 * Record a new trip
 */
router.post('/', async (req, res) => {
  try {
    const {
      originName,
      originAddress,
      originLat,
      originLng,
      destinationName,
      destinationAddress,
      destinationLat,
      destinationLng,
      departureTime,
      arrivalTime,
      distanceMeters,
      durationSeconds,
      delaySeconds,
      typicalDuration,
      tripScore,
      routePolyline,
      trafficConditions,
    } = req.body;

    // Validate required fields
    if (!originLat || !originLng || !destinationLat || !destinationLng) {
      return res.status(400).json({ error: 'Origin and destination coordinates required' });
    }
    if (!departureTime || !distanceMeters || !durationSeconds) {
      return res.status(400).json({ error: 'departureTime, distanceMeters, and durationSeconds required' });
    }

    // Calculate time saved
    let timeSavedSeconds = null;
    if (typicalDuration) {
      timeSavedSeconds = typicalDuration - durationSeconds;
    }

    const trip = await prisma.trip.create({
      data: {
        userId: req.user.id,
        originName,
        originAddress,
        originLat,
        originLng,
        destinationName,
        destinationAddress,
        destinationLat,
        destinationLng,
        departureTime: new Date(departureTime),
        arrivalTime: arrivalTime ? new Date(arrivalTime) : null,
        distanceMeters,
        durationSeconds,
        delaySeconds: delaySeconds || 0,
        typicalDuration,
        timeSavedSeconds,
        tripScore,
        routePolyline,
        trafficConditions: trafficConditions ? JSON.stringify(trafficConditions) : null,
      },
    });

    // Update saved place visit count if destination matches
    if (destinationLat && destinationLng) {
      await prisma.savedPlace.updateMany({
        where: {
          userId: req.user.id,
          latitude: { gte: destinationLat - 0.001, lte: destinationLat + 0.001 },
          longitude: { gte: destinationLng - 0.001, lte: destinationLng + 0.001 },
        },
        data: {
          visitCount: { increment: 1 },
          lastVisited: new Date(),
        },
      });
    }

    res.status(201).json({ trip });
  } catch (error) {
    logger.error('Create trip error:', error.message);
    res.status(500).json({ error: 'Failed to record trip' });
  }
});

/**
 * GET /api/trips/stats
 * Get trip statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const { period = 'week' } = req.query;

    // Calculate date range
    const now = new Date();
    let startDate;
    switch (period) {
      case 'day':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    const trips = await prisma.trip.findMany({
      where: {
        userId: req.user.id,
        departureTime: { gte: startDate },
      },
      select: {
        distanceMeters: true,
        durationSeconds: true,
        delaySeconds: true,
        timeSavedSeconds: true,
        tripScore: true,
      },
    });

    // Calculate stats
    const totalTrips = trips.length;
    const totalDistance = trips.reduce((sum, t) => sum + t.distanceMeters, 0);
    const totalDuration = trips.reduce((sum, t) => sum + t.durationSeconds, 0);
    const totalDelay = trips.reduce((sum, t) => sum + (t.delaySeconds || 0), 0);
    const totalTimeSaved = trips.reduce((sum, t) => sum + (t.timeSavedSeconds || 0), 0);
    const avgTripScore = trips.length > 0
      ? trips.reduce((sum, t) => sum + (t.tripScore || 0), 0) / trips.filter(t => t.tripScore).length
      : 0;

    res.json({
      period,
      stats: {
        totalTrips,
        totalDistanceKm: Math.round(totalDistance / 1000),
        totalDurationMinutes: Math.round(totalDuration / 60),
        totalDelayMinutes: Math.round(totalDelay / 60),
        totalTimeSavedMinutes: Math.round(totalTimeSaved / 60),
        averageTripScore: Math.round(avgTripScore),
        averageTripDistanceKm: totalTrips > 0 ? Math.round(totalDistance / totalTrips / 1000) : 0,
        averageTripDurationMinutes: totalTrips > 0 ? Math.round(totalDuration / totalTrips / 60) : 0,
      },
    });
  } catch (error) {
    logger.error('Get stats error:', error.message);
    res.status(500).json({ error: 'Failed to get trip statistics' });
  }
});

/**
 * GET /api/trips/:id
 * Get a specific trip
 */
router.get('/:id', async (req, res) => {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });

    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    res.json({ trip });
  } catch (error) {
    logger.error('Get trip error:', error.message);
    res.status(500).json({ error: 'Failed to get trip' });
  }
});

/**
 * DELETE /api/trips/:id
 * Delete a trip
 */
router.delete('/:id', async (req, res) => {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });

    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    await prisma.trip.delete({
      where: { id: req.params.id },
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete trip error:', error.message);
    res.status(500).json({ error: 'Failed to delete trip' });
  }
});

module.exports = router;
