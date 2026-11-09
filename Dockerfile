# COLDEST Order Merge Engine: container image (Railway picks this up automatically)
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY tsconfig.json ./

# Cloud defaults. Everything else (keys, passwords) is set in Railway → Variables.
#  - listen on all interfaces, on the PORT Railway provides (one port for dashboard + webhooks)
#  - database and logs live on the Railway volume mounted at /data
#  - Railway terminates HTTPS in front of the app: trust its proxy headers, HTTPS-only cookies
ENV HOST=0.0.0.0 \
    SINGLE_PORT=true \
    TRUST_PROXY=true \
    COOKIE_SECURE=true \
    DATABASE_FILE=/data/coldest-merge.sqlite \
    LOG_FILE=/data/engine.log

CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"]
