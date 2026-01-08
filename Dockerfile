FROM node:20-alpine

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies and generate Prisma client
RUN npm ci --omit=dev && npx prisma generate

# Copy source code
COPY src ./src/

# Expose port
EXPOSE 3000

# Start the app
CMD ["node", "src/index.js"]
