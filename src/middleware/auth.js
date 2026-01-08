const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const logger = require('../utils/logger');

// JWT secret - should be in env vars
const JWT_SECRET = process.env.JWT_SECRET || 'yalla-jwt-secret-change-in-production';

/**
 * Middleware to verify JWT token and load user
 * Attaches user to req.user if valid
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;

    // Load full user object
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { preferences: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (err) {
    logger.warn('Invalid token:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Optional auth - attaches user if token provided, but doesn't require it
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next(); // Continue without user
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (user) {
      req.user = user;
    }
  } catch (err) {
    // Ignore auth errors for optional auth
  }

  next();
}

module.exports = { requireAuth, optionalAuth };
