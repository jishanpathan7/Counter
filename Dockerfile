# syntax=docker/dockerfile:1
# Production image: the app, its built web screens and Litestream (continuous database backups).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM litestream/litestream:0.5.18 AS litestream

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3001 NODE_OPTIONS=--no-warnings=ExperimentalWarning
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
COPY --chmod=755 deploy/entrypoint.sh /usr/local/bin/entrypoint
# Which build this is, shown in /api/health and error reports: --build-arg APP_RELEASE=$(git rev-parse --short HEAD)
ARG APP_RELEASE=dev
ENV APP_RELEASE=$APP_RELEASE
RUN mkdir -p /data/institutes && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["entrypoint"]
