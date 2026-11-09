# syntax=docker/dockerfile:1.7
# Spending Tracker: one Node process serving the API, the MCP endpoint and the built web app.
#   docker build -t spending-tracker .
#   docker run -d -p 127.0.0.1:8787:8787 -v spending-data:/data spending-tracker
# Or `docker compose up -d` with compose.yaml.

ARG NODE_VERSION=24
ARG PNPM_VERSION=12.16.1

# ---- context-check: proves data/ and secrets stay out of the build context ---------------------
# Not part of the image. Run it with `docker build --target context-check .`
FROM busybox:1.37 AS context-check
WORKDIR /ctx
COPY . .
RUN echo "files: $(find . -type f | wc -l)  size: $(du -sh . | cut -f1)" \
 && ! find . \( -name '*.db' -o -name '*.db-*' -o -name 'secret.key' -o -name '.env*' -o -path '*/data/*' \
      -o -path '*/.demo-data/*' -o -path '*/node_modules/*' -o -path '*/.git/*' -o -path '*/.claude/*' \) \
      -print | grep . \
 && find . -type f | sort

# ---- build: install from the lockfile, build the web app and MCP, bundle the server ------------
FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /src

# Manifests first, so the install layer is cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/mcp/package.json apps/mcp/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile

COPY . .
# apps/web/dist, apps/mcp/dist/stdio.js and the server bundle, apps/server/dist/index.mjs
RUN pnpm build
# better-sqlite3 is the one package the bundle leaves out. It ships N-API prebuilds for linux
# glibc/musl x64/arm64 and has no runtime dependencies: keep only this platform's binary.
RUN set -eu; \
    mkdir -p /out/node_modules; \
    cp -rL "$(dirname "$(node -p "require.resolve('better-sqlite3/package.json', {paths: ['apps/server']})")")" /out/node_modules/better-sqlite3; \
    cd /out/node_modules/better-sqlite3; \
    rm -rf deps src binding.gyp; \
    arch="$(node -p 'process.arch')"; \
    find prebuilds -type f ! -name "linux-${arch}.node" -delete; \
    node -e "const D=require('/out/node_modules/better-sqlite3'); new D(':memory:').prepare('select 1').get()"

# ---- runtime ------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
# org.opencontainers.image.source: add the repository URL here once it's public, e.g.
# LABEL org.opencontainers.image.source="https://github.com/<owner>/spending-tracker"
LABEL org.opencontainers.image.title="Spending Tracker" \
      org.opencontainers.image.description="Self-hosted spending, accounts and net worth tracker: web app, REST API and MCP server in one container"
ENV NODE_ENV=production \
    DATA_DIR=/data \
    API_PORT=8787 \
    HOST=0.0.0.0
WORKDIR /app
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./apps/server/dist
COPY --from=build /src/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY --from=build /src/apps/mcp/dist ./apps/mcp/dist
USER node
# meta.db, ledgers/, backups/ and secret.key. Keep this volume, and back it up.
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The server stops cleanly on SIGTERM itself (closing its databases), so node can be PID 1.
CMD ["node", "apps/server/dist/index.mjs"]
