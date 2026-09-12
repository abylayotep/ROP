# Pinned to the same provider client revision used by Tasbaqa.
FROM node:20-alpine
ARG KASPI_POS_REPO=https://github.com/tapter-dev/kaspi-pos-automation.git
ARG KASPI_POS_REF=327d0d0a804e0e64450b645d2df2540927f75e20
RUN apk add --no-cache git \
 && git clone "$KASPI_POS_REPO" /app \
 && cd /app && git checkout "$KASPI_POS_REF" \
 && npm ci --omit=dev && apk del git
WORKDIR /app
RUN npm install --no-save --omit=dev socks-proxy-agent@8.0.4
COPY fetch-proxied.js /app/src/fetch-proxied.js
RUN sed -i "s#import fetch from 'node-fetch';#import fetch from './fetch-proxied.js';#" /app/src/helpers.js /app/src/polling.js \
 && grep -q "fetch-proxied" /app/src/helpers.js \
 && grep -q "fetch-proxied" /app/src/polling.js
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
COPY entrypoint.sh /entrypoint.sh
COPY webhooks.json /app/webhooks.json
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
