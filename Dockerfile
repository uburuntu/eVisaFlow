ARG PLAYWRIGHT_VERSION=1.62.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY service/package.json ./service/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY tsup.config.ts ./
COPY packages/protocol/tsconfig.json ./packages/protocol/tsconfig.json
COPY src ./src
COPY bin ./bin

RUN pnpm run build:lib

CMD ["node", "./bin/evisa-flow.js"]
