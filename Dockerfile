FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- deps stage: production dependencies only ----
FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev

# ---- build stage: compile TypeScript + generate Prisma client ----
FROM base AS builder
# Override NODE_ENV so npm ci installs devDependencies (typescript, etc.)
ENV NODE_ENV=development
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma
RUN npm run db:generate
RUN npm run build

# ---- runtime stage ----
FROM base AS runner

# Prisma's query/schema engine binaries require libssl at runtime on Alpine.
RUN apk add --no-cache openssl

# Run as a non-root user: reduces blast radius if Node.js is compromised.
# node:20-alpine ships with a built-in "node" user (uid 1000).
RUN chown -R node:node /app
USER node

# Production node_modules (prisma CLI is now a production dep, so it's included)
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
# Compiled JS
COPY --chown=node:node --from=builder /app/dist ./dist
# Prisma schema + migrations
COPY --chown=node:node --from=builder /app/prisma ./prisma
# Prisma-generated client binaries built for this exact Alpine image
COPY --chown=node:node --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=node:node package.json ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Run pending migrations then start the server.
# exec is required so Node.js receives SIGTERM directly (not via sh).
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/index.js"]
