FROM mcr.microsoft.com/playwright:v1.58.0-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY scripts ./scripts

RUN npm run build

CMD ["node", "./bin/evisa-flow.js"]
