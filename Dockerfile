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

RUN pnpm run build:lib

CMD ["node", "./bin/evisa-flow.js"]
