ARG GO_VERSION=1.26.9

FROM golang:${GO_VERSION}-alpine3.23 AS docker-cli-build

ARG DOCKER_CLI_COMMIT=f415da838bed6a0e12ca6cb86ba198fdac6beb9c
RUN apk add --no-cache bash git
WORKDIR /go/src/github.com/docker/cli
RUN git init \
  && git remote add origin https://github.com/docker/cli.git \
  && git fetch --depth 1 origin "${DOCKER_CLI_COMMIT}" \
  && git checkout --detach FETCH_HEAD
RUN CGO_ENABLED=0 TARGET=/out VERSION=29.9.0 ./scripts/build/binary

FROM node:22.23.3-alpine

RUN apk add --no-cache bash curl git \
  && mkdir -p /data \
  && chown node:node /data

COPY --from=docker-cli-build /out/docker /usr/local/bin/docker

WORKDIR /app
COPY --chown=node:node --chmod=0644 server.mjs ./server.mjs
COPY --chown=node:node --chmod=0644 release-gateway.mjs ./release-gateway.mjs

USER node
EXPOSE 3300
CMD ["node", "/app/server.mjs"]
