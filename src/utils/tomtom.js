const axios = require('axios');
const logger = require('./logger');

const TOMTOM_BASE_URL = 'https://api.tomtom.com';

/**
 * Create axios instance for TomTom API calls
 */
const tomtomClient = axios.create({
  baseURL: TOMTOM_BASE_URL,
  timeout: 10000,
});

// Request interceptor - add API key
tomtomClient.interceptors.request.use((config) => {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) {
    throw new Error('TOMTOM_API_KEY not configured');
  }

  // Add API key to query params
  config.params = config.params || {};
  config.params.key = apiKey;

  return config;
});

// Response interceptor - handle errors
tomtomClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      logger.error('TomTom API error:', {
        status: error.response.status,
        url: error.config?.url,
        message: error.response.data?.error?.description || error.message,
      });

      // Don't expose internal API details to clients
      const status = error.response.status;
      if (status === 401 || status === 403) {
        throw new Error('API authentication failed');
      } else if (status === 429) {
        throw new Error('Rate limit exceeded');
      } else if (status >= 500) {
        throw new Error('External service unavailable');
      }
    }
    throw error;
  }
);

module.exports = tomtomClient;
