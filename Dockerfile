# syntax=docker/dockerfile:1

# ── Base image with pnpm enabled ──────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ── Install dependencies (cached on lockfile) ─────────────────────────────────
FROM base AS deps
# pnpm-workspace.yaml is required here, not optional: pnpm 11 reads the
# `allowBuilds` allowlist from it. Without the file in the build context, no
# package is allowed to run a postinstall script — which is why this stage used
# to need `pnpm config set dangerouslyAllowAllBuilds true`, a flag that permits
# arbitrary postinstall scripts from *every* transitive dependency. Copying the
# allowlist in is the same outcome with none of the supply-chain exposure.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# -- on ubuntu server its need, do not remove
ENV NODE_OPTIONS="--max-old-space-size=512"

RUN pnpm install --frozen-lockfile --network-concurrency=1 --child-concurrency=1

# ── Build the Next.js app ─────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholder env so `next build` passes env validation. Real values are
# provided at runtime; NEXT_PUBLIC_APP_URL is read server-side at request time.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV APP_SECRET=build-time-placeholder-secret-not-used-at-runtime
ENV NEXT_PUBLIC_APP_URL=http://localhost:3000
# Optional: bake the Pusher Beams instance id into the client bundle (NEXT_PUBLIC_*
# vars are inlined at build time). Pass with:
#   docker compose build --build-arg NEXT_PUBLIC_PUSHER_BEAMS_INSTANCE_ID=xxxxxxxx
ARG NEXT_PUBLIC_PUSHER_BEAMS_INSTANCE_ID=""
ENV NEXT_PUBLIC_PUSHER_BEAMS_INSTANCE_ID=$NEXT_PUBLIC_PUSHER_BEAMS_INSTANCE_ID
# Optional: bake the Pusher Channels key/cluster into the client bundle (a
# different Pusher product from Beams above — enables real-time ticket
# updates). Pass with:
#   docker compose build --build-arg NEXT_PUBLIC_PUSHER_KEY=xxxxxxxx --build-arg NEXT_PUBLIC_PUSHER_CLUSTER=us2
ARG NEXT_PUBLIC_PUSHER_KEY=""
ENV NEXT_PUBLIC_PUSHER_KEY=$NEXT_PUBLIC_PUSHER_KEY
ARG NEXT_PUBLIC_PUSHER_CLUSTER=""
ENV NEXT_PUBLIC_PUSHER_CLUSTER=$NEXT_PUBLIC_PUSHER_CLUSTER
RUN pnpm build

# ── Runtime image (serves app or runs worker / migrations) ────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Stamped by CI (see .github/workflows/release.yml) and reported by
# GET /api/health, so an operator can tell which build a container is running.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# Source is needed at runtime for the pg-boss worker (tsx) and drizzle migrations.
# --chown matters: the app runs as the unprivileged `node` user below, and
# Next.js writes into .next/cache at runtime.
COPY --chown=node:node . .
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next

# Attachment directory for the default `local` storage driver. Created here,
# owned by `node`, so that a *fresh* named volume mounted over it inherits that
# ownership from the image and the app can write to it as non-root.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# scripts/docker-entrypoint.sh is bash (`wait -n` supervises web + worker), and
# node:22-alpine ships only busybox sh. The repo tracks scripts as mode 644, so
# set the exec bit here rather than relying on the checkout.
RUN apk add --no-cache bash \
  && chmod +x /app/scripts/docker-entrypoint.sh

USER node

EXPOSE 3000

# Compose/orchestrators can rely on this instead of declaring their own probe.
# /api/health is unauthenticated on purpose and checks DB reachability.
# start-period covers the slowest legitimate boot: in the default "all" role the
# web server starts only AFTER migrations have been applied.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

# Every explicit command (the `command:` of each docker-compose service, or
# `docker run <image> sh`) is exec'd verbatim by the entrypoint. "docket" is a
# sentinel meaning "no command given — read DOCKET_ROLE, default all": migrate,
# then web server AND worker in this one container. That is for platforms that
# deploy a registry image once and have no `command:` to set (Dokploy, Coolify,
# CapRover, a bare `docker run`). It must be a real value, not an empty CMD, or
# the base image's inherited `CMD ["node"]` would take its place.
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["docket"]

# OCI metadata. This is what renders on the GitHub Packages page, and what links
# the package back to this repository.
LABEL org.opencontainers.image.title="Docket" \
      org.opencontainers.image.description="Open-source, self-hosted customer support ticketing system." \
      org.opencontainers.image.url="https://github.com/stack256org/docket" \
      org.opencontainers.image.source="https://github.com/stack256org/docket" \
      org.opencontainers.image.documentation="https://github.com/stack256org/docket#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Stack256"
