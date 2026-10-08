FROM node:22.23.3-alpine

RUN apk add --no-cache bash curl docker-cli docker-cli-compose git \
  && mkdir -p /data \
  && chown node:node /data

WORKDIR /app
COPY server.mjs ./server.mjs

USER node
EXPOSE 3300
CMD ["node", "/app/server.mjs"]
