FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY packages/common/package.json packages/common/package.json
COPY services/api/package.json services/api/package.json

RUN npm ci

COPY packages/common/tsconfig.json packages/common/tsconfig.json
COPY packages/common/src packages/common/src
RUN npm -w @thumbnailer/common run build

COPY services/api/tsconfig.json services/api/tsconfig.json
COPY services/api/src services/api/src

RUN npm -w @thumbnailer/api run build

CMD ["npm", "-w", "@thumbnailer/api", "run", "start"]
