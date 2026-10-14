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

FROM golang:${GO_VERSION}-alpine3.23 AS docker-compose-build

ARG DOCKER_COMPOSE_COMMIT=42f48072bbf92ee9b0e43f9fdf2008d03546e7ca
ARG X_NET_VERSION=v0.60.0
RUN apk add --no-cache git
WORKDIR /go/src/github.com/docker/compose
RUN git init \
  && git remote add origin https://github.com/docker/compose.git \
  && git fetch --depth 1 origin "${DOCKER_COMPOSE_COMMIT}" \
  && git checkout --detach FETCH_HEAD
RUN go get "golang.org/x/net@${X_NET_VERSION}"
RUN CGO_ENABLED=0 GO111MODULE=on go build \
  -trimpath \
  -tags e2e \
  -ldflags "-w -X github.com/docker/compose/v5/internal.Version=v5.6.0" \
  -o /out/docker-compose ./cmd

FROM node:22.23.3-alpine

RUN apk add --no-cache bash curl git \
  && mkdir -p /data /usr/local/lib/docker/cli-plugins \
  && chown node:node /data

COPY --from=docker-cli-build /out/docker /usr/local/bin/docker
COPY --from=docker-compose-build /out/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose

WORKDIR /app
COPY --chown=node:node --chmod=0644 server.mjs ./server.mjs

USER node
EXPOSE 3300
CMD ["node", "/app/server.mjs"]
