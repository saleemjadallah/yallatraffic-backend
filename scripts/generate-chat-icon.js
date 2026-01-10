#!/usr/bin/env node
/**
 * Generate Yalla Chat Icon using Gemini Imagen 3
 *
 * Run: node scripts/generate-chat-icon.js
 */

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY not set in environment');
  process.exit(1);
}

async function generateChatIcon() {
  console.log('🎨 Generating Yalla Chat icon...\n');

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  // Use Gemini 2.0 Flash with image generation capability
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-exp',
    generationConfig: {
      responseModalities: ['Text', 'Image']
    }
  });

  const prompt = `Generate an image: A perfectly circular app icon for a friendly traffic chat assistant called Yalla.

CRITICAL: The icon must be a PERFECT CIRCLE with NO square edges, NO rectangular elements, NO corners.

Design:
- Perfectly round circular shape filling the entire canvas
- Warm coral orange gradient background (#FF6B6B to #E85D5D)
- White stylized chat bubble or speech symbol in the center
- Maybe a small road/car element integrated into the design
- Minimalist, modern, flat design style
- Friendly and approachable feeling
- The entire image should be circular like a coin or button
- No background outside the circle - the circle IS the icon`;

  try {
    console.log('📤 Sending request to Gemini 2.0 Flash...');

    const result = await model.generateContent(prompt);
    const response = result.response;

    // Check for inline image data
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imageData = part.inlineData.data;
        const mimeType = part.inlineData.mimeType;

        console.log('✅ Image generated! MIME type:', mimeType);

        // Decode base64 image
        const buffer = Buffer.from(imageData, 'base64');

        // Save to frontend assets
        const ext = mimeType.includes('png') ? 'png' : 'jpg';
        const outputPath = path.join(
          __dirname,
          `../../frontend/assets/images/yalla_chat_icon.${ext}`
        );

        // Ensure directory exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(outputPath, buffer);

        console.log('✅ Icon saved to:', outputPath);
        console.log('\n🎉 Done! The icon is ready to use in the app.');
        return;
      }
    }

    // No image in response
    console.log('⚠️ No image in response. Creating placeholder...');
    await createPlaceholderIcon();

  } catch (error) {
    console.error('❌ Error generating image:', error.message);
    console.log('\n💡 Creating a placeholder icon instead...\n');
    await createPlaceholderIcon();
  }
}

async function createPlaceholderIcon() {
  // Create a simple SVG icon as placeholder
  const svgIcon = `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Background circle -->
  <circle cx="36" cy="36" r="36" fill="url(#gradient)"/>

  <!-- Speech bubble with road -->
  <path d="M18 28C18 23.5817 21.5817 20 26 20H46C50.4183 20 54 23.5817 54 28V40C54 44.4183 50.4183 48 46 48H40L36 54L32 48H26C21.5817 48 18 44.4183 18 40V28Z" fill="white"/>

  <!-- Road icon inside bubble -->
  <path d="M28 32H44V36H28V32Z" fill="#FF6B6B" opacity="0.6"/>
  <path d="M34 30V42" stroke="#FF6B6B" stroke-width="2" stroke-dasharray="3 2"/>
  <path d="M38 30V42" stroke="#FF6B6B" stroke-width="2" stroke-dasharray="3 2"/>

  <!-- Car dot -->
  <circle cx="36" cy="38" r="3" fill="#FF6B6B"/>

  <defs>
    <linearGradient id="gradient" x1="0" y1="0" x2="72" y2="72" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FF8A80"/>
      <stop offset="50%" stop-color="#FF6B6B"/>
      <stop offset="100%" stop-color="#E85D5D"/>
    </linearGradient>
  </defs>
</svg>`;

  const outputDir = path.join(__dirname, '../../frontend/assets/images');

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Save SVG
  const svgPath = path.join(outputDir, 'yalla_chat_icon.svg');
  fs.writeFileSync(svgPath, svgIcon);
  console.log('✅ SVG icon saved to:', svgPath);

  // For Flutter, we'll also need to convert to PNG
  // For now, we'll create a simple note
  console.log('\n📝 Note: For best results, convert the SVG to PNG using:');
  console.log('   - Figma, Sketch, or Adobe Illustrator');
  console.log('   - Or online tools like https://svgtopng.com');
  console.log('   Save as: frontend/assets/images/yalla_chat_icon.png (72x72 px)');
}

// Run the script
generateChatIcon();
