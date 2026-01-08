const admin = require('firebase-admin');
const prisma = require('../utils/prisma');
const logger = require('../utils/logger');

/**
 * Send push notification to a user
 */
async function sendToUser(userId, notification, data = {}) {
  try {
    // Get active push tokens for user
    const tokens = await prisma.pushToken.findMany({
      where: { userId, isActive: true },
    });

    if (tokens.length === 0) {
      logger.info(`No push tokens for user ${userId}`);
      return { success: false, reason: 'no_tokens' };
    }

    const results = await Promise.all(
      tokens.map((token) => sendToToken(token.token, notification, data))
    );

    // Deactivate invalid tokens
    const invalidTokens = tokens.filter((_, i) => results[i].invalidToken);
    if (invalidTokens.length > 0) {
      await prisma.pushToken.updateMany({
        where: { id: { in: invalidTokens.map((t) => t.id) } },
        data: { isActive: false },
      });
    }

    const successCount = results.filter((r) => r.success).length;
    return { success: successCount > 0, sent: successCount, total: tokens.length };
  } catch (error) {
    logger.error('Send to user error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send push notification to a specific token
 */
async function sendToToken(token, notification, data = {}) {
  try {
    if (!admin.apps.length) {
      logger.warn('Firebase not initialized - cannot send push notification');
      return { success: false, reason: 'firebase_not_initialized' };
    }

    const message = {
      token,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'yalla_traffic',
        },
      },
    };

    await admin.messaging().send(message);
    logger.info(`Push sent to token ${token.slice(0, 10)}...`);
    return { success: true };
  } catch (error) {
    logger.error('Push error:', error.message);

    // Check if token is invalid
    if (
      error.code === 'messaging/invalid-registration-token' ||
      error.code === 'messaging/registration-token-not-registered'
    ) {
      return { success: false, invalidToken: true };
    }

    return { success: false, error: error.message };
  }
}

/**
 * Send departure alert to user
 */
async function sendDepartureAlert(userId, destinationName, etaMinutes, trafficStatus) {
  const statusEmoji = {
    free: '🟢',
    light: '🟡',
    moderate: '🟠',
    heavy: '🔴',
    severe: '⛔',
  };

  const emoji = statusEmoji[trafficStatus] || '🚗';

  return sendToUser(
    userId,
    {
      title: `${emoji} Time to leave for ${destinationName}`,
      body: `ETA: ${etaMinutes} min. Leave now for the best route!`,
    },
    {
      type: 'departure_alert',
      destination: destinationName,
      eta_minutes: String(etaMinutes),
    }
  );
}

/**
 * Send traffic incident alert
 */
async function sendIncidentAlert(userId, incidentType, roadName, severity) {
  const typeEmoji = {
    accident: '🚨',
    hazard: '⚠️',
    police: '👮',
    roadwork: '🚧',
    congestion: '🚗',
  };

  const emoji = typeEmoji[incidentType] || '📍';

  return sendToUser(
    userId,
    {
      title: `${emoji} ${incidentType.charAt(0).toUpperCase() + incidentType.slice(1)} reported`,
      body: `${severity} incident on ${roadName || 'your route'}`,
    },
    {
      type: 'incident_alert',
      incident_type: incidentType,
      road_name: roadName || '',
      severity,
    }
  );
}

/**
 * Send weekly summary
 */
async function sendWeeklySummary(userId, stats) {
  return sendToUser(
    userId,
    {
      title: '📊 Your Weekly Traffic Summary',
      body: `${stats.totalTrips} trips, ${stats.timeSavedMinutes} min saved! 🎉`,
    },
    {
      type: 'weekly_summary',
      total_trips: String(stats.totalTrips),
      time_saved: String(stats.timeSavedMinutes),
    }
  );
}

module.exports = {
  sendToUser,
  sendToToken,
  sendDepartureAlert,
  sendIncidentAlert,
  sendWeeklySummary,
};
