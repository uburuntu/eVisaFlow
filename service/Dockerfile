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
COPY service/tsconfig.json ./service/tsconfig.json
COPY service/src ./service/src

RUN pnpm run build:service

WORKDIR /app/service

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const port=process.env.HEALTH_PORT||8080; fetch('http://127.0.0.1:'+port+'/ready').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
