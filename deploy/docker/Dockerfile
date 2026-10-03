FROM node:22.23.3-bookworm-slim

ARG PI_VERSION=1.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-client \
        ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /workspace /home/node/.pi \
    && chown -R node:node /workspace /home/node/.pi

USER node
WORKDIR /workspace

ENV HOME=/home/node

CMD ["sleep", "infinity"]

