FROM node:22.23.3-alpine3.24

ARG PI_VERSION=1.3.0
ARG PNPM_VERSION=12.14.0

RUN apk upgrade --no-cache \
    && apk add --no-cache \
        ca-certificates \
        curl \
        git \
        openssh-client \
        ripgrep \
    && npm install -g --ignore-scripts \
        "@earendil-works/pi-coding-agent@${PI_VERSION}" \
        "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /workspace /home/node/.pi/agent \
    && printf '{"npmCommand":["pnpm"]}\n' > /home/node/.pi/agent/settings.json \
    && chown -R node:node /workspace /home/node/.pi

USER node
WORKDIR /workspace

ENV HOME=/home/node

CMD ["sleep", "infinity"]

