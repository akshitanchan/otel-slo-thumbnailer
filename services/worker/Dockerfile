FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.js ./
COPY services/worker/package.json services/worker/package.json

RUN npm ci

COPY services/worker/tsconfig.json services/worker/tsconfig.json
COPY services/worker/src services/worker/src

RUN npm -w @thumbnailer/worker run build

CMD ["npm", "-w", "@thumbnailer/worker", "run", "start"]
