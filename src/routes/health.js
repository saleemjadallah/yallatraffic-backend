const express = require('express');
const { getStats } = require('../utils/cache');

const router = express.Router();

/**
 * GET /health
 * Health check endpoint for Railway/monitoring
 */
router.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    tomtomConfigured: !!process.env.TOMTOM_API_KEY,
  });
});

/**
 * GET /health/cache
 * Cache statistics
 */
router.get('/cache', (req, res) => {
  res.json({
    status: 'healthy',
    cacheStats: getStats(),
  });
});

module.exports = router;
