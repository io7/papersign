# syntax=docker/dockerfile:1
# PaperSign production image. One image runs the web app, the PDF worker,
# migrations and the operator commands; see docker/compose.yaml and
# docs/self-hosting.md.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ARG PAPERSIGN_VERSION=dev
LABEL org.opencontainers.image.title="PaperSign" \
      org.opencontainers.image.description="Self-hosted PDF signing" \
      org.opencontainers.image.version="${PAPERSIGN_VERSION}" \
      org.opencontainers.image.source="https://github.com/io7/papersign" \
      org.opencontainers.image.licenses="MIT"
# tini forwards signals and reaps the PDF processing child processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3176 \
    DATA_DIR=/data \
    BACKUP_FILE=/backups/papersign.dump
WORKDIR /app
# Application files stay owned by root and read-only for the service user.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/licenses ./licenses
COPY --from=build /app/LICENSE /app/README.md /app/THIRD-PARTY-SIGNING.md ./
COPY docker/entrypoint.sh /usr/local/bin/papersign
RUN chmod 0755 /usr/local/bin/papersign \
 && mkdir -p /data /backups \
 && chown node:node /data /backups \
 && chmod 0700 /data
USER node
VOLUME ["/data"]
EXPOSE 3176
ENTRYPOINT ["tini", "--", "papersign"]
CMD ["web"]
