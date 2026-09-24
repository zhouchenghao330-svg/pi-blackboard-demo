FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev \
    && npm cache clean --force

COPY src ./src
COPY labs/blackboard/ingest.mjs ./labs/blackboard/ingest.mjs
COPY public ./public
RUN mkdir -p /data/pi-agent /data/uploads /data/outputs \
    && chown -R node:node /data

ENV NODE_ENV=production \
    PORT=3000 \
    PI_CODING_AGENT_DIR=/data/pi-agent \
    DEMO_DATA_DIR=/data

USER node
EXPOSE 3000
CMD ["npm", "start"]
