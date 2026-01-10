/**
 * Yalla Chat API Routes
 *
 * AI-powered conversational traffic assistant using Gemini 2.0 Flash
 */

const express = require('express');
const { chat } = require('../services/yallaChatService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /api/chat
 * Send a message to Yalla chat assistant
 *
 * Body:
 *   - message: The user's question (required)
 *   - userLocation: { lat, lon } - optional user location for context
 *   - conversationHistory: Array of previous messages (optional)
 *
 * Response:
 *   - success: boolean
 *   - message: The assistant's response
 *   - toolsUsed: Array of tools that were called
 */
router.post('/', async (req, res) => {
  try {
    const { message, userLocation, conversationHistory } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Message is required',
      });
    }

    // Limit message length
    if (message.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Message too long (max 1000 characters)',
      });
    }

    // Validate conversation history if provided
    if (conversationHistory && !Array.isArray(conversationHistory)) {
      return res.status(400).json({
        success: false,
        error: 'conversationHistory must be an array',
      });
    }

    // Limit conversation history to prevent token overflow
    const limitedHistory = conversationHistory?.slice(-10) || [];

    logger.info(`[Chat API] Received message: "${message.substring(0, 50)}..."`);

    const result = await chat(message, {
      userLocation,
      conversationHistory: limitedHistory,
    });

    res.json(result);

  } catch (error) {
    logger.error(`[Chat API] Error: ${error.message}`, { stack: error.stack });

    res.status(500).json({
      success: false,
      message: "Sorry, I'm having trouble right now. Please try again in a moment!",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * GET /api/chat/health
 * Check if chat service is available
 */
router.get('/health', async (req, res) => {
  try {
    // Check if Gemini API key is configured
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        status: 'unavailable',
        reason: 'GEMINI_API_KEY not configured',
      });
    }

    res.json({
      status: 'healthy',
      service: 'yalla-chat',
      model: 'gemini-2.0-flash',
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
    });
  }
});

/**
 * GET /api/chat/suggestions
 * Get conversation starter suggestions based on context
 */
router.get('/suggestions', async (req, res) => {
  const { hasLocation } = req.query;

  // Context-aware suggestions
  const suggestions = hasLocation === 'true'
    ? [
        "What's traffic like around me?",
        "Best route to Dubai Mall?",
        "When should I leave for work?",
        "Any incidents nearby?",
      ]
    : [
        "How's traffic on Sheikh Zayed Road?",
        "What's the fastest route to Dubai Mall?",
        "Any accidents reported in Dubai?",
        "Best time to go to Marina?",
      ];

  res.json({ suggestions });
});

module.exports = router;
