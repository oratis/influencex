FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install server dependencies
COPY package*.json ./
RUN npm ci --only=production

# Install client dependencies and build
COPY client/package*.json client/
RUN cd client && npm ci
COPY client/ client/
RUN cd client && npx vite build

# Copy server code
COPY server/ server/

# Expose port
ENV PORT=8080
ENV BASE_PATH=/InfluenceX
EXPOSE 8080

CMD ["node", "server/index.js"]
