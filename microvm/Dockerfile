ARG FLOCI_VERSION=2.4.0
ARG AWS_EMULATOR_VERSION=1.0.338
ARG NPM_VERSION=12.2.2

FROM floci/floci:${FLOCI_VERSION} AS floci

FROM node:24.22.2-bookworm-slim AS app
ARG NPM_VERSION
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --global "npm@${NPM_VERSION}" --no-audit --no-fund \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev --no-audit --no-fund

FROM node:24.22.2-bookworm-slim AS runtime
WORKDIR /app
ARG AWS_EMULATOR_VERSION
ARG NPM_VERSION
RUN npm install --global "npm@${NPM_VERSION}" --no-audit --no-fund \
  && apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl gnupg libatomic1 \
  && curl -fsSLo /tmp/aws-emulator.deb "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator_${AWS_EMULATOR_VERSION}-1_arm64.deb" \
  && curl -fsSLo /tmp/aws-emulator.deb.sig "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator_${AWS_EMULATOR_VERSION}-1_arm64.deb.sig" \
  && curl -fsSLo /tmp/aws-publishing.asc https://downloads.aws.com/keys/gpg/current.asc \
  && FINGERPRINT="$(gpg --batch --show-keys --with-colons /tmp/aws-publishing.asc | awk -F: '$1 == "fpr" { print toupper($10); exit }')" \
  && test "$FINGERPRINT" = "98BCF336A3BE53B734E967C52E5BF49BD940F624" \
  && gpg --batch --import /tmp/aws-publishing.asc \
  && gpg --batch --verify /tmp/aws-emulator.deb.sig /tmp/aws-emulator.deb \
  && apt-get install -y --no-install-recommends /tmp/aws-emulator.deb \
  && apt-get purge -y --auto-remove curl gnupg \
  && rm -f /tmp/aws-emulator.deb /tmp/aws-emulator.deb.sig /tmp/aws-publishing.asc \
  && rm -rf /root/.gnupg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=floci /app/application /app/application
COPY --from=floci /app/quarkus-artifact.properties /app/quarkus-artifact.properties
COPY --from=app /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY lib ./lib
COPY src ./src
COPY tests ./tests
COPY config ./config
COPY scripts ./scripts
COPY vitest.config.ts ./vitest.config.ts
COPY server.mjs ./server.mjs
RUN chown -R root:root /app \
  && chmod -R a+rX /app \
  && chmod 775 /app \
  && chown -R 1001:root /app/config \
  && chmod 775 /app/config \
  && chmod 664 /app/config/aws-endpoint.json \
  && chown -R 1001:root /app/src /app/tests \
  && printf 'floci:x:1001:0:Floci Workshop:/tmp:/bin/bash\n' >> /etc/passwd

ENV NODE_ENV=production \
    FLOCI_URL=http://127.0.0.1:4566 \
    FLOCI_STORAGE_MODE=memory \
    AWS_REGION=ap-northeast-1 \
    AWS_DEFAULT_REGION=ap-northeast-1 \
    AWS_ACCESS_KEY_ID=test \
    AWS_SECRET_ACCESS_KEY=test \
    AWS_EC2_METADATA_DISABLED=true \
    EMULATOR_TELEMETRY=off \
    QUARKUS_HTTP_HOST=127.0.0.1 \
    HOME=/tmp \
    TMPDIR=/tmp

USER floci:root
EXPOSE 8080 8081
CMD ["node", "server.mjs"]
