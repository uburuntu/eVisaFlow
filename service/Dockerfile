FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY service/package.json ./service/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json biome.json ./
COPY src ./src
COPY bin ./bin
COPY scripts ./scripts
COPY service/tsconfig.json ./service/tsconfig.json
COPY service/src ./service/src

RUN pnpm run build:service

WORKDIR /app/service

CMD ["node", "dist/index.js"]
