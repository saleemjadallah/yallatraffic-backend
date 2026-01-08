const express = require('express');
const jwt = require('jsonwebtoken');
const appleSignIn = require('apple-signin-auth');
const prisma = require('../utils/prisma');
const logger = require('../utils/logger');

const router = express.Router();

// JWT secret - should be in env vars
const JWT_SECRET = process.env.JWT_SECRET || 'yalla-jwt-secret-change-in-production';
const JWT_EXPIRES_IN = '30d';

/**
 * POST /api/auth/apple
 * Verify Apple Sign In token and create/get user
 */
router.post('/apple', async (req, res) => {
  try {
    const { identityToken, authorizationCode, nonce, email, givenName, familyName } = req.body;

    if (!identityToken) {
      return res.status(400).json({ error: 'Identity token is required' });
    }

    // Verify the identity token with Apple
    let appleUser;
    try {
      appleUser = await appleSignIn.verifyIdToken(identityToken, {
        audience: process.env.APPLE_CLIENT_ID, // Your app's bundle ID
        nonce: nonce ? require('crypto').createHash('sha256').update(nonce).digest('hex') : undefined,
      });
    } catch (verifyError) {
      logger.error('Apple token verification failed:', verifyError);
      return res.status(401).json({ error: 'Invalid Apple token' });
    }

    const appleUserId = appleUser.sub;

    // Find or create user
    let user = await prisma.user.findUnique({
      where: { appleUserId },
      include: { preferences: true },
    });

    if (!user) {
      // Create new user
      user = await prisma.user.create({
        data: {
          appleUserId,
          email: email || appleUser.email,
          givenName,
          familyName,
          displayName: givenName ? `${givenName}${familyName ? ' ' + familyName : ''}` : null,
          preferences: {
            create: {}, // Create with defaults
          },
        },
        include: { preferences: true },
      });
      logger.info(`New user created: ${user.id}`);
    } else {
      // Update last login and any new info
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          // Only update name if provided and not already set
          ...(givenName && !user.givenName ? { givenName } : {}),
          ...(familyName && !user.familyName ? { familyName } : {}),
          ...(givenName && !user.displayName ? {
            displayName: `${givenName}${familyName ? ' ' + familyName : ''}`
          } : {}),
        },
        include: { preferences: true },
      });
      logger.info(`User logged in: ${user.id}`);
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, appleUserId },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      token,
      user: formatUser(user),
    });
  } catch (error) {
    logger.error('Apple sign in error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

/**
 * GET /api/auth/me
 * Get current user
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { preferences: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: formatUser(user) });
  } catch (error) {
    logger.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * PATCH /api/auth/me
 * Update user preferences
 */
router.patch('/me', authenticateToken, async (req, res) => {
  try {
    const { displayName, notificationsEnabled, commuteReminderMinutes, avoidTolls, avoidHighways } = req.body;

    // Update user
    const updateData = {};
    if (displayName !== undefined) updateData.displayName = displayName;

    let user = await prisma.user.update({
      where: { id: req.userId },
      data: updateData,
      include: { preferences: true },
    });

    // Update preferences if provided
    if (notificationsEnabled !== undefined || commuteReminderMinutes !== undefined ||
        avoidTolls !== undefined || avoidHighways !== undefined) {
      const prefsData = {};
      if (notificationsEnabled !== undefined) prefsData.notificationsEnabled = notificationsEnabled;
      if (commuteReminderMinutes !== undefined) prefsData.commuteReminderMinutes = commuteReminderMinutes;
      if (avoidTolls !== undefined) prefsData.avoidTolls = avoidTolls;
      if (avoidHighways !== undefined) prefsData.avoidHighways = avoidHighways;

      await prisma.userPreferences.upsert({
        where: { userId: req.userId },
        update: prefsData,
        create: { userId: req.userId, ...prefsData },
      });

      // Refetch user with updated preferences
      user = await prisma.user.findUnique({
        where: { id: req.userId },
        include: { preferences: true },
      });
    }

    res.json({ user: formatUser(user) });
  } catch (error) {
    logger.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * POST /api/auth/signout
 * Sign out (invalidate push tokens)
 */
router.post('/signout', authenticateToken, async (req, res) => {
  try {
    // Deactivate all push tokens for this user
    await prisma.pushToken.updateMany({
      where: { userId: req.userId },
      data: { isActive: false },
    });

    logger.info(`User signed out: ${req.userId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Sign out error:', error);
    res.status(500).json({ error: 'Sign out failed' });
  }
});

/**
 * POST /api/auth/push-token
 * Register APNs push token
 */
router.post('/push-token', authenticateToken, async (req, res) => {
  try {
    const { token, platform = 'ios', deviceId, bundleId } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Push token is required' });
    }

    // Upsert push token
    await prisma.pushToken.upsert({
      where: {
        userId_token: {
          userId: req.userId,
          token,
        },
      },
      update: {
        isActive: true,
        platform,
        deviceId,
        bundleId,
        updatedAt: new Date(),
      },
      create: {
        userId: req.userId,
        token,
        platform,
        deviceId,
        bundleId,
      },
    });

    logger.info(`Push token registered for user: ${req.userId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Register push token error:', error);
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

/**
 * Middleware to authenticate JWT token
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      logger.warn('Invalid token:', err.message);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.userId = decoded.userId;
    next();
  });
}

/**
 * Format user for response
 */
function formatUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    givenName: user.givenName,
    familyName: user.familyName,
    avatarUrl: user.photoUrl,
    notificationsEnabled: user.preferences?.notificationsEnabled ?? true,
    commuteReminderMinutes: user.preferences?.commuteReminderMinutes ?? 15,
    avoidTolls: user.preferences?.avoidTolls ?? false,
    avoidHighways: user.preferences?.avoidHighways ?? false,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString(),
  };
}

// Export middleware for use in other routes
module.exports = router;
module.exports.authenticateToken = authenticateToken;
