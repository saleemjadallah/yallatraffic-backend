const axios = require('axios');
const logger = require('./logger');

const GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com/v1';

/**
 * Create axios instance for Google Places API (New) calls
 */
const googlePlacesClient = axios.create({
  baseURL: GOOGLE_PLACES_BASE_URL,
  timeout: 10000,
});

// Request interceptor - add API key and headers
googlePlacesClient.interceptors.request.use((config) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY not configured');
  }

  // Google Places API (New) uses header-based authentication
  config.headers['X-Goog-Api-Key'] = apiKey;
  config.headers['Content-Type'] = 'application/json';

  return config;
});

// Response interceptor - handle errors
googlePlacesClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      logger.error('Google Places API error:', {
        status: error.response.status,
        url: error.config?.url,
        message: error.response.data?.error?.message || error.message,
      });

      const status = error.response.status;
      if (status === 401 || status === 403) {
        throw new Error('Google API authentication failed');
      } else if (status === 429) {
        throw new Error('Rate limit exceeded');
      } else if (status >= 500) {
        throw new Error('External service unavailable');
      }
    }
    throw error;
  }
);

/**
 * Search for places using Google Places Text Search (New)
 * @param {string} query - Search text
 * @param {object} options - Search options
 * @param {number} options.lat - Latitude for location bias
 * @param {number} options.lng - Longitude for location bias
 * @param {number} options.radius - Radius in meters for location bias
 * @param {number} options.limit - Maximum number of results
 * @returns {Promise<Array>} Array of place results
 */
async function searchPlaces(query, options = {}) {
  const { lat, lng, radius = 50000, limit = 20 } = options;

  const requestBody = {
    textQuery: query,
    languageCode: 'en',
    maxResultCount: Math.min(limit, 20), // Google Places API max is 20
  };

  // Add location bias if coordinates provided
  if (lat && lng) {
    requestBody.locationBias = {
      circle: {
        center: {
          latitude: parseFloat(lat),
          longitude: parseFloat(lng),
        },
        radius: parseFloat(radius),
      },
    };
  }

  // Request only the fields we need (reduces cost)
  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.location',
    'places.types',
    'places.primaryType',
    'places.shortFormattedAddress',
  ].join(',');

  const response = await googlePlacesClient.post(
    '/places:searchText',
    requestBody,
    {
      headers: {
        'X-Goog-FieldMask': fieldMask,
      },
    }
  );

  return response.data.places || [];
}

/**
 * Autocomplete search using Google Places Autocomplete (New)
 * @param {string} input - Partial search text
 * @param {object} options - Search options
 * @param {number} options.lat - Latitude for location bias
 * @param {number} options.lng - Longitude for location bias
 * @returns {Promise<Array>} Array of autocomplete suggestions
 */
async function autocomplete(input, options = {}) {
  const { lat, lng } = options;

  const requestBody = {
    input,
    languageCode: 'en',
  };

  // Add location bias if coordinates provided
  if (lat && lng) {
    requestBody.locationBias = {
      circle: {
        center: {
          latitude: parseFloat(lat),
          longitude: parseFloat(lng),
        },
        radius: 50000, // 50km radius
      },
    };
  }

  const response = await googlePlacesClient.post(
    '/places:autocomplete',
    requestBody
  );

  return response.data.suggestions || [];
}

/**
 * Get place details by place ID
 * @param {string} placeId - Google Place ID
 * @returns {Promise<object>} Place details
 */
async function getPlaceDetails(placeId) {
  const fieldMask = [
    'id',
    'displayName',
    'formattedAddress',
    'location',
    'types',
    'primaryType',
    'shortFormattedAddress',
  ].join(',');

  const response = await googlePlacesClient.get(`/places/${placeId}`, {
    headers: {
      'X-Goog-FieldMask': fieldMask,
    },
  });

  return response.data;
}

/**
 * Transform Google Places result to our standard format
 * @param {object} place - Google Places result
 * @returns {object} Standardized place object
 */
function transformPlace(place) {
  return {
    id: place.id,
    name: place.displayName?.text || place.formattedAddress,
    address: place.formattedAddress || place.shortFormattedAddress,
    position: place.location
      ? {
          lat: place.location.latitude,
          lon: place.location.longitude,
        }
      : null,
    category: place.primaryType || place.types?.[0] || 'place',
    type: 'POI',
    source: 'google',
  };
}

/**
 * Transform autocomplete suggestion to our standard format
 * @param {object} suggestion - Google Places autocomplete suggestion
 * @returns {object} Standardized suggestion object
 */
function transformSuggestion(suggestion) {
  const place = suggestion.placePrediction;
  if (!place) return null;

  return {
    id: place.placeId,
    text: place.text?.text || place.structuredFormat?.mainText?.text,
    secondaryText: place.structuredFormat?.secondaryText?.text,
    placeId: place.placeId,
    types: place.types || [],
  };
}

module.exports = {
  searchPlaces,
  autocomplete,
  getPlaceDetails,
  transformPlace,
  transformSuggestion,
};
