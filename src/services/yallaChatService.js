/**
 * Yalla Chat Service - AI-powered traffic assistant
 *
 * Uses Gemini 2.0 Flash with function calling to:
 * - Answer traffic questions conversationally
 * - Find routes and compare options
 * - Check traffic conditions
 * - Suggest optimal departure times
 * - Report and query incidents
 */

const { getFlashModel, CHAT_GENERATION_CONFIG } = require('../config/gemini');
const tomtom = require('../utils/tomtom');
const googlePlaces = require('../utils/googlePlaces');
const logger = require('../utils/logger');

// System prompt for Yalla personality
const YALLA_SYSTEM_PROMPT = `You are Yalla (يلا), a friendly and helpful Dubai traffic assistant. Your personality:

- Warm and conversational - you're a helpful friend, not a robot
- Use emojis occasionally to add personality (but don't overdo it)
- Give concise, actionable answers
- Celebrate good traffic conditions and empathize with bad ones
- You know Dubai roads well - Sheikh Zayed Road, Al Khail, E11, Business Bay, Marina, DIFC, etc.
- When suggesting routes, explain WHY one is better
- Always offer to help further at the end

IMPORTANT:
- Use the provided tools to get real-time traffic data - never make up traffic information
- If a tool call fails, apologize and offer alternatives
- Convert times to minutes/hours in a human-friendly way
- For locations, always clarify if you're unsure which place the user means
- Keep responses under 150 words unless the user asks for details
- When reporting multiple routes, use formatting to make it easy to compare`;

// Define the tools available to the AI
const TRAFFIC_TOOLS = [
  {
    name: 'search_place',
    description: 'Search for a place by name and get its coordinates. Use this when the user mentions a destination like "Dubai Mall", "DIFC", "Marina Mall", etc.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The place name to search for (e.g., "Dubai Mall", "DIFC", "Marina Mall")'
        },
        nearLat: {
          type: 'number',
          description: 'Optional latitude to bias search results near this location'
        },
        nearLon: {
          type: 'number',
          description: 'Optional longitude to bias search results near this location'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'calculate_routes',
    description: 'Calculate driving routes between two points. Returns multiple route options with traffic-aware ETAs, distances, and delay information.',
    parameters: {
      type: 'object',
      properties: {
        originLat: {
          type: 'number',
          description: 'Origin latitude'
        },
        originLon: {
          type: 'number',
          description: 'Origin longitude'
        },
        destLat: {
          type: 'number',
          description: 'Destination latitude'
        },
        destLon: {
          type: 'number',
          description: 'Destination longitude'
        }
      },
      required: ['originLat', 'originLon', 'destLat', 'destLon']
    }
  },
  {
    name: 'get_traffic_flow',
    description: 'Get current traffic flow conditions at a specific location. Returns current speed, free flow speed, and traffic condition.',
    parameters: {
      type: 'object',
      properties: {
        lat: {
          type: 'number',
          description: 'Latitude of the location'
        },
        lon: {
          type: 'number',
          description: 'Longitude of the location'
        }
      },
      required: ['lat', 'lon']
    }
  },
  {
    name: 'get_departure_times',
    description: 'Calculate optimal departure times by comparing ETAs at different times (now, +30min, +1hr, +2hr). Use this when user asks "when should I leave" or "best time to go".',
    parameters: {
      type: 'object',
      properties: {
        originLat: {
          type: 'number',
          description: 'Origin latitude'
        },
        originLon: {
          type: 'number',
          description: 'Origin longitude'
        },
        destLat: {
          type: 'number',
          description: 'Destination latitude'
        },
        destLon: {
          type: 'number',
          description: 'Destination longitude'
        }
      },
      required: ['originLat', 'originLon', 'destLat', 'destLon']
    }
  },
  {
    name: 'get_incidents',
    description: 'Get traffic incidents (accidents, construction, road closures) near a location or along a route.',
    parameters: {
      type: 'object',
      properties: {
        lat: {
          type: 'number',
          description: 'Center latitude'
        },
        lon: {
          type: 'number',
          description: 'Center longitude'
        },
        radiusKm: {
          type: 'number',
          description: 'Search radius in kilometers (default 5)'
        }
      },
      required: ['lat', 'lon']
    }
  }
];

// Tool execution functions - these call the actual APIs
const toolExecutors = {
  async search_place({ query, nearLat, nearLon }) {
    try {
      logger.info(`[YallaChat] Searching for place: ${query}`);

      const options = {};
      if (nearLat && nearLon) {
        options.lat = nearLat;
        options.lng = nearLon;
        options.radius = 50000; // 50km
      }

      const results = await googlePlaces.searchPlaces(query, options);

      if (!results || results.length === 0) {
        return { error: 'No places found', query };
      }

      // Transform and return top 3 results
      const places = results.slice(0, 3).map(p => googlePlaces.transformPlace(p));

      logger.info(`[YallaChat] Found ${places.length} places for: ${query}`);
      return { places, query };
    } catch (error) {
      logger.error(`[YallaChat] search_place error: ${error.message}`);
      return { error: error.message, query };
    }
  },

  async calculate_routes({ originLat, originLon, destLat, destLon }) {
    try {
      logger.info(`[YallaChat] Calculating routes from ${originLat},${originLon} to ${destLat},${destLon}`);

      const response = await tomtom.get(
        `/routing/1/calculateRoute/${originLat},${originLon}:${destLat},${destLon}/json`,
        {
          params: {
            routeType: 'fastest',
            traffic: true,
            travelMode: 'car',
            maxAlternatives: 2,
            computeTravelTimeFor: 'all',
            sectionType: 'traffic',
          }
        }
      );

      const routes = response.data.routes;
      if (!routes || routes.length === 0) {
        return { error: 'No routes found' };
      }

      // Format routes for AI consumption
      const formattedRoutes = routes.map((r, i) => ({
        routeNumber: i + 1,
        durationMinutes: Math.round(r.summary.travelTimeInSeconds / 60),
        distanceKm: (r.summary.lengthInMeters / 1000).toFixed(1),
        trafficDelayMinutes: Math.round((r.summary.trafficDelayInSeconds || 0) / 60),
        arrivalTime: r.summary.arrivalTime,
      }));

      logger.info(`[YallaChat] Found ${formattedRoutes.length} routes`);
      return { routes: formattedRoutes };
    } catch (error) {
      logger.error(`[YallaChat] calculate_routes error: ${error.message}`);
      return { error: error.message };
    }
  },

  async get_traffic_flow({ lat, lon }) {
    try {
      logger.info(`[YallaChat] Getting traffic flow at ${lat},${lon}`);

      const response = await tomtom.get(
        `/traffic/services/4/flowSegmentData/relative0/10/json`,
        {
          params: {
            point: `${lat},${lon}`,
            unit: 'KMPH',
          }
        }
      );

      const flow = response.data.flowSegmentData;
      if (!flow) {
        return { error: 'Could not get traffic flow' };
      }

      const currentSpeed = flow.currentSpeed;
      const freeFlowSpeed = flow.freeFlowSpeed;
      let condition = 'clear';

      if (currentSpeed < freeFlowSpeed * 0.3) {
        condition = 'severe';
      } else if (currentSpeed < freeFlowSpeed * 0.5) {
        condition = 'heavy';
      } else if (currentSpeed < freeFlowSpeed * 0.7) {
        condition = 'moderate';
      } else if (currentSpeed < freeFlowSpeed * 0.9) {
        condition = 'light';
      }

      return {
        currentSpeedKmh: Math.round(currentSpeed),
        freeFlowSpeedKmh: Math.round(freeFlowSpeed),
        condition: condition,
        roadClosed: flow.roadClosure || false,
      };
    } catch (error) {
      logger.error(`[YallaChat] get_traffic_flow error: ${error.message}`);
      return { error: error.message };
    }
  },

  async get_departure_times({ originLat, originLon, destLat, destLon }) {
    try {
      logger.info(`[YallaChat] Calculating departure times`);

      const offsets = [0, 30, 60, 120]; // minutes
      const results = [];

      for (const offset of offsets) {
        const departAt = new Date(Date.now() + offset * 60 * 1000);

        try {
          const response = await tomtom.get(
            `/routing/1/calculateRoute/${originLat},${originLon}:${destLat},${destLon}/json`,
            {
              params: {
                routeType: 'fastest',
                traffic: true,
                travelMode: 'car',
                departAt: departAt.toISOString(),
                computeTravelTimeFor: 'all',
              }
            }
          );

          const route = response.data.routes?.[0];
          if (route) {
            results.push({
              label: offset === 0 ? 'Now' : `+${offset} min`,
              departureTime: departAt.toISOString(),
              durationMinutes: Math.round(route.summary.travelTimeInSeconds / 60),
              trafficDelayMinutes: Math.round((route.summary.trafficDelayInSeconds || 0) / 60),
            });
          }
        } catch (e) {
          logger.warn(`[YallaChat] Failed to get departure time for +${offset}min`);
        }
      }

      if (results.length === 0) {
        return { error: 'Could not calculate departure times' };
      }

      // Find best option
      const best = results.reduce((min, r) => r.durationMinutes < min.durationMinutes ? r : min, results[0]);
      results.forEach(r => r.isBest = r.label === best.label);

      const timeSaved = results[0].durationMinutes - best.durationMinutes;

      return {
        departureTimes: results,
        recommendation: best.label === 'Now'
          ? 'Now is the best time to leave!'
          : `Wait ${best.label.replace('+', '')} to save ${timeSaved} minutes`,
      };
    } catch (error) {
      logger.error(`[YallaChat] get_departure_times error: ${error.message}`);
      return { error: error.message };
    }
  },

  async get_incidents({ lat, lon, radiusKm = 5 }) {
    try {
      logger.info(`[YallaChat] Getting incidents near ${lat},${lon}`);

      // Calculate bounding box from center + radius
      const latDelta = radiusKm / 111; // ~111km per degree of latitude
      const lonDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));

      const minLat = lat - latDelta;
      const maxLat = lat + latDelta;
      const minLon = lon - lonDelta;
      const maxLon = lon + lonDelta;

      const response = await tomtom.get('/traffic/services/5/incidentDetails', {
        params: {
          bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
          fields: '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description},from,to,delay,roadNumbers}}}',
          language: 'en-GB',
          categoryFilter: '0,1,2,3,4,5,6,7,8,9,10,11,14',
          timeValidityFilter: 'present',
        }
      });

      const incidents = response.data.incidents || [];

      if (incidents.length === 0) {
        return { incidents: [], message: 'No incidents reported in this area - roads are clear!' };
      }

      // Format incidents for AI
      const formattedIncidents = incidents.slice(0, 5).map(inc => {
        const props = inc.properties || {};
        return {
          type: getIncidentTypeName(props.iconCategory),
          description: props.events?.[0]?.description || 'Traffic incident',
          from: props.from,
          to: props.to,
          delayMinutes: props.delay ? Math.round(props.delay / 60) : null,
          severity: getMagnitudeLabel(props.magnitudeOfDelay),
        };
      });

      return {
        incidents: formattedIncidents,
        totalCount: incidents.length,
      };
    } catch (error) {
      logger.error(`[YallaChat] get_incidents error: ${error.message}`);
      return { error: error.message };
    }
  }
};

// Helper functions
function getIncidentTypeName(iconCategory) {
  const types = {
    0: 'Unknown',
    1: 'Accident',
    2: 'Fog',
    3: 'Dangerous Conditions',
    4: 'Rain',
    5: 'Ice',
    6: 'Jam',
    7: 'Lane Closed',
    8: 'Road Closed',
    9: 'Road Works',
    10: 'Wind',
    11: 'Flooding',
    14: 'Broken Down Vehicle',
  };
  return types[iconCategory] || 'Incident';
}

function getMagnitudeLabel(magnitude) {
  const labels = {
    0: 'Unknown',
    1: 'Minor',
    2: 'Moderate',
    3: 'Major',
    4: 'Severe',
  };
  return labels[magnitude] || 'Unknown';
}

/**
 * Process a chat message and return AI response
 */
async function chat(message, context = {}) {
  const { userLocation, conversationHistory = [] } = context;

  try {
    logger.info(`[YallaChat] Processing message: "${message.substring(0, 50)}..."`);

    const model = getFlashModel();

    // Build the conversation with system prompt
    const chatSession = model.startChat({
      generationConfig: CHAT_GENERATION_CONFIG,
      history: [
        {
          role: 'user',
          parts: [{ text: 'System: ' + YALLA_SYSTEM_PROMPT }]
        },
        {
          role: 'model',
          parts: [{ text: 'Hey! I\'m Yalla, your friendly Dubai traffic assistant! 🚗 How can I help you get where you need to go today?' }]
        },
        ...conversationHistory
      ],
      tools: [{
        functionDeclarations: TRAFFIC_TOOLS
      }]
    });

    // Add user location context if available
    let enrichedMessage = message;
    if (userLocation) {
      enrichedMessage = `[User's current location: lat ${userLocation.lat}, lon ${userLocation.lon}]\n\nUser: ${message}`;
    }

    // Send message and handle function calls
    let response = await chatSession.sendMessage(enrichedMessage);
    let responseText = '';
    let iterations = 0;
    const maxIterations = 5; // Prevent infinite loops
    const toolsUsed = [];

    while (iterations < maxIterations) {
      iterations++;
      const candidate = response.response.candidates?.[0];

      if (!candidate) {
        logger.error('[YallaChat] No candidate in response');
        break;
      }

      // Check if model wants to call a function
      const functionCall = candidate.content.parts.find(p => p.functionCall);

      if (functionCall) {
        const { name, args } = functionCall.functionCall;
        logger.info(`[YallaChat] Executing tool: ${name}`, { args });
        toolsUsed.push(name);

        // Execute the tool
        const executor = toolExecutors[name];
        if (executor) {
          const result = await executor(args);
          logger.info(`[YallaChat] Tool ${name} result:`, { result });

          // Send function result back to model
          response = await chatSession.sendMessage([{
            functionResponse: {
              name: name,
              response: result
            }
          }]);
        } else {
          logger.error(`[YallaChat] Unknown tool: ${name}`);
          break;
        }
      } else {
        // No more function calls, get the text response
        responseText = candidate.content.parts
          .filter(p => p.text)
          .map(p => p.text)
          .join('');
        break;
      }
    }

    logger.info(`[YallaChat] Response generated (${responseText.length} chars, ${toolsUsed.length} tools used)`);

    return {
      success: true,
      message: responseText,
      toolsUsed: toolsUsed,
    };

  } catch (error) {
    logger.error(`[YallaChat] Error: ${error.message}`, { stack: error.stack });

    // Return a friendly error message
    return {
      success: false,
      message: "Oops! I had trouble processing that. Could you try rephrasing your question? 🤔",
      error: error.message
    };
  }
}

module.exports = {
  chat,
  TRAFFIC_TOOLS,
  toolExecutors
};
