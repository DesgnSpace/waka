# Bun-native API server (replaces the Next.js runtime). No build step — Bun runs
# server.ts directly. Reuses src/lib + src/server; src/app (the old Next UI) is
# unused here and will be rebuilt as HTMX later.

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# oven/bun ships a non-root `bun` user.
USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["bun", "server.ts"]
