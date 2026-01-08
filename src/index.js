require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

// Route imports - TomTom proxy
const trafficRoutes = require('./routes/traffic');
const routingRoutes = require('./routes/routing');
const searchRoutes = require('./routes/search');
const geocodingRoutes = require('./routes/geocoding');

// Route imports - User features
const usersRoutes = require('./routes/users');
const tripsRoutes = require('./routes/trips');
const incidentsRoutes = require('./routes/incidents');

// Health check
const healthRoutes = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting - 100 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// API Routes - TomTom proxy (public)
app.use('/api/traffic', trafficRoutes);
app.use('/api/routing', routingRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/geocoding', geocodingRoutes);

// API Routes - User features (authenticated)
app.use('/api/users', usersRoutes);
app.use('/api/trips', tripsRoutes);
app.use('/api/incidents', incidentsRoutes);

// Health check
app.use('/health', healthRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Yalla Backend API',
    version: '1.1.0',
    status: 'running',
    endpoints: {
      health: '/health',
      // TomTom proxy (public)
      traffic: '/api/traffic',
      routing: '/api/routing',
      search: '/api/search',
      geocoding: '/api/geocoding',
      // User features (auth required)
      users: '/api/users',
      trips: '/api/trips',
      incidents: '/api/incidents',
    },
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(`Error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 Yalla Backend running on port ${PORT}`);
  logger.info(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);

  if (!process.env.TOMTOM_API_KEY) {
    logger.warn('⚠️  TOMTOM_API_KEY not set - API calls will fail');
  }
  if (!process.env.DATABASE_URL) {
    logger.warn('⚠️  DATABASE_URL not set - database features will fail');
  }
});
