# Debian rather than Alpine, with build tools in the build stage only: argon2 is a
# native module and must compile when no prebuilt binary matches the platform.
FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Manifests first, so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY rakurs/package.json rakurs/
COPY server/package.json server/
COPY scripts scripts
RUN npm ci
# Workspaces hoist everything to the root, so this directory exists only when a version
# conflict forces a package-local copy. Make sure it is there for the COPY below either way.
RUN mkdir -p server/node_modules

COPY packages/contract packages/contract
COPY server server
RUN npm --prefix server run build

FROM node:26-bookworm-slim
WORKDIR /app/server
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/drizzle ./drizzle
COPY --from=build /app/server/package.json ./
COPY --from=build /app/server/drizzle.config.ts ./
CMD ["node", "dist/index.js"]
