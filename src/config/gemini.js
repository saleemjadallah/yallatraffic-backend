/**
 * Google Gemini AI configuration for Yalla Traffic Assistant
 *
 * Uses Gemini 2.0 Flash for fast, conversational traffic assistance
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Safety settings - balanced for general audience
const SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
  },
];

// Generation config for chat - conversational and helpful
const CHAT_GENERATION_CONFIG = {
  temperature: 0.9,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 1024,
};

// Generation config for analysis - more precise
const ANALYSIS_GENERATION_CONFIG = {
  temperature: 0.3,
  topP: 0.8,
  topK: 20,
  maxOutputTokens: 2048,
};

// Get Flash model for fast chat responses
const getFlashModel = () => genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  safetySettings: SAFETY_SETTINGS,
});

// Get model with function calling for tool use
const getFlashModelWithTools = (tools) => genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  safetySettings: SAFETY_SETTINGS,
  tools: tools,
});

module.exports = {
  genAI,
  SAFETY_SETTINGS,
  CHAT_GENERATION_CONFIG,
  ANALYSIS_GENERATION_CONFIG,
  getFlashModel,
  getFlashModelWithTools,
};
