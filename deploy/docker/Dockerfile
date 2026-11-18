FROM node:22.23.4-alpine3.24

ARG PI_VERSION=1.3.0
ARG NPM_VERSION=12.2.3
ARG UNDICI_VERSION=8.12.2
ARG CURL_VERSION=8.23.0-r0
ARG EXPAT_VERSION=2.10.0-r0
ARG OPENSSL_VERSION=3.5.9-r1

COPY deploy/docker/patch-runtime-npm.mjs /tmp/patch-runtime-npm.mjs

# Pi pins an affected HTTP client. Replace the actual package code, not its
# version metadata; keep Pi's CLI/protocol version stable until upstream fixes it.
RUN apk upgrade --no-cache \
    && echo "@curlfix https://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories \
    && apk add --no-cache \
        ca-certificates \
        "curl@curlfix=${CURL_VERSION}" \
        git \
        "libcurl@curlfix=${CURL_VERSION}" \
        "libexpat=${EXPAT_VERSION}" \
        "libcrypto3@curlfix=${OPENSSL_VERSION}" \
        "libssl3@curlfix=${OPENSSL_VERSION}" \
        openssh-client \
        ripgrep \
    && npm install -g --ignore-scripts \
        "@earendil-works/pi-coding-agent@${PI_VERSION}" \
        "npm@${NPM_VERSION}" \
        "undici@${UNDICI_VERSION}" \
    && node /tmp/patch-runtime-npm.mjs /usr/local/lib/node_modules/npm \
    && rm /tmp/patch-runtime-npm.mjs \
    && rm -rf /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici \
    && cp -a /usr/local/lib/node_modules/undici /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici \
    && npm pkg set "dependencies.undici=${UNDICI_VERSION}" --prefix /usr/local/lib/node_modules/@earendil-works/pi-coding-agent \
    && node -e 'const a=require("node:assert/strict"),p="/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici";a.equal(require(p+"/package.json").version,process.argv[1]);const {MockAgent,fetch}=require(p);const m=new MockAgent();m.disableNetConnect();m.get("https://fixture.invalid").intercept({path:"/healthz"}).reply(200,"ok");fetch("https://fixture.invalid/healthz",{dispatcher:m}).then(r=>r.text()).then(t=>a.equal(t,"ok")).finally(()=>m.close()).catch(()=>process.exit(1))' "$UNDICI_VERSION" \
    && pi --version \
    && test "$(npm --version)" = "$NPM_VERSION" \
    && npm cache clean --force \
    && mkdir -p /workspace /home/node/.pi/agent \
    && printf '{"npmCommand":["npm"]}\n' > /home/node/.pi/agent/settings.json \
    && chown -R node:node /workspace /home/node/.pi

USER node
WORKDIR /workspace

ENV HOME=/home/node

CMD ["sleep", "infinity"]

