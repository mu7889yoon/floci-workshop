ARG FLOCI_VERSION=2.4.0

FROM floci/floci:${FLOCI_VERSION} AS floci

FROM node:24.22.2-bookworm-slim AS app
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev --no-audit --no-fund

FROM node:24.22.2-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash libatomic1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=floci /app/application /app/application
COPY --from=floci /app/quarkus-artifact.properties /app/quarkus-artifact.properties
COPY --from=app /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY lib ./lib
COPY src ./src
COPY tests ./tests
COPY vitest.config.ts ./vitest.config.ts
COPY server.mjs ./server.mjs
RUN chown -R root:root /app \
  && chmod -R a+rX /app \
  && chmod 775 /app \
  && chown -R 1001:root /app/src /app/tests

ENV NODE_ENV=production \
    FLOCI_URL=http://127.0.0.1:4566 \
    FLOCI_STORAGE_MODE=memory \
    AWS_REGION=ap-northeast-1 \
    AWS_DEFAULT_REGION=ap-northeast-1 \
    AWS_ACCESS_KEY_ID=test \
    AWS_SECRET_ACCESS_KEY=test \
    AWS_EC2_METADATA_DISABLED=true \
    QUARKUS_HTTP_HOST=127.0.0.1 \
    HOME=/tmp \
    TMPDIR=/tmp

USER 1001:0
EXPOSE 8080 8081
CMD ["node", "server.mjs"]
