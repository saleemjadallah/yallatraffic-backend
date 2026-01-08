const admin = require('firebase-admin');
const prisma = require('../utils/prisma');
const logger = require('../utils/logger');

// Initialize Firebase Admin (lazy initialization)
let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;

  try {
    // Check if service account is configured
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Use default credentials file
      admin.initializeApp();
    } else {
      logger.warn('Firebase not configured - auth endpoints will return 503');
      return;
    }
    firebaseInitialized = true;
    logger.info('Firebase Admin initialized');
  } catch (error) {
    logger.error('Failed to initialize Firebase:', error.message);
  }
}

/**
 * Middleware to verify Firebase ID token
 * Attaches user to req.user if valid
 */
async function requireAuth(req, res, next) {
  initFirebase();

  if (!firebaseInitialized) {
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    // Find or create user in database
    let user = await prisma.user.findUnique({
      where: { firebaseUid: decodedToken.uid },
      include: { preferences: true },
    });

    if (!user) {
      // Create new user on first login
      user = await prisma.user.create({
        data: {
          firebaseUid: decodedToken.uid,
          email: decodedToken.email,
          displayName: decodedToken.name,
          photoUrl: decodedToken.picture,
          preferences: {
            create: {}, // Create with defaults
          },
        },
        include: { preferences: true },
      });
      logger.info(`New user created: ${user.id}`);
    }

    req.user = user;
    req.firebaseUser = decodedToken;
    next();
  } catch (error) {
    logger.error('Auth error:', error.message);

    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (error.code === 'auth/argument-error') {
      return res.status(401).json({ error: 'Invalid token' });
    }

    return res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional auth - attaches user if token provided, but doesn't require it
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(); // Continue without user
  }

  initFirebase();
  if (!firebaseInitialized) {
    return next();
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const user = await prisma.user.findUnique({
      where: { firebaseUid: decodedToken.uid },
    });
    req.user = user;
    req.firebaseUser = decodedToken;
  } catch (error) {
    // Ignore auth errors for optional auth
  }

  next();
}

module.exports = { requireAuth, optionalAuth, initFirebase };
