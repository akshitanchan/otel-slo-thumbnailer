FROM node:20-bookworm-slim

WORKDIR /app

# copy workspace manifests first for better caching
COPY package.json package-lock.json tsconfig.base.json eslint.config.js ./
COPY services/migrate/package.json services/migrate/package.json

RUN npm ci

COPY services/migrate/tsconfig.json services/migrate/tsconfig.json
COPY services/migrate/src services/migrate/src
COPY db/migrations db/migrations

RUN npm -w @thumbnailer/migrate run build

CMD ["npm", "-w", "@thumbnailer/migrate", "run", "start"]
