FROM node:24.22.3-bookworm-slim@sha256:e0e989b967dacc279681ed81774b2ce9eeebbb0efb8e0c427573235bebf1eda1 AS node
FROM python:3.12.14-slim-bookworm@sha256:1aaa65a85fda306ffb8b910824d4e93bdce61e212c7e87168123ea3073b41a1a
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git libseccomp2 \
        fonts-liberation fonts-noto-core fonts-noto-color-emoji \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
        libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
        libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && groupadd --gid 1000 agent \
    && useradd --create-home --uid 1000 --gid 1000 agent
ENV HOME=/home/agent TZ=UTC
USER 1000:1000
