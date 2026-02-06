FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends libvips-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY services/worker/package.json services/worker/package.json

RUN npm ci

COPY services/worker/tsconfig.json services/worker/tsconfig.json
COPY services/worker/src services/worker/src

RUN npm -w @thumbnailer/worker run build

CMD ["npm", "-w", "@thumbnailer/worker", "run", "start"]
