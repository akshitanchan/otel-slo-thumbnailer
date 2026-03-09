FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends libvips-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY packages/common/package.json packages/common/package.json
COPY services/worker/package.json services/worker/package.json

RUN npm ci

COPY packages/common/tsconfig.json packages/common/tsconfig.json
COPY packages/common/src packages/common/src
RUN npm -w @thumbnailer/common run build

COPY services/worker/tsconfig.json services/worker/tsconfig.json
COPY services/worker/src services/worker/src

RUN npm -w @thumbnailer/worker run build

CMD ["npm", "-w", "@thumbnailer/worker", "run", "start"]
