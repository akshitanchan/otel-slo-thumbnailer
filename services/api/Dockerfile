FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs ./
COPY services/api/package.json services/api/package.json

RUN npm ci

COPY services/api/tsconfig.json services/api/tsconfig.json
COPY services/api/src services/api/src

RUN npm -w @thumbnailer/api run build

CMD ["npm", "-w", "@thumbnailer/api", "run", "start"]
