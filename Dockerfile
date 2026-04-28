FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install server dependencies. --legacy-peer-deps lets the OpenTelemetry
# auto-instrumentations package resolve its conflicting peer constraints
# (otel/core 1.x vs 2.x); without this `npm ci` fails on ERESOLVE.
COPY package*.json ./
RUN npm ci --only=production --legacy-peer-deps

# Install client dependencies and build
COPY client/package*.json client/
RUN cd client && npm ci --legacy-peer-deps
COPY client/ client/
RUN cd client && npx vite build

# Copy server code
COPY server/ server/

# Copy docs/ — server/changelog.js reads docs/CHANGELOG.md at runtime to
# expose release notes via /api/changelog. Without this the parsed entries
# come back empty in prod.
COPY docs/ docs/

# Expose port
ENV PORT=8080
ENV BASE_PATH=""
EXPOSE 8080

CMD ["node", "server/index.js"]
