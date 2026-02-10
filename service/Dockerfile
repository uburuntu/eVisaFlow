FROM mcr.microsoft.com/playwright:v1.58.0-jammy

WORKDIR /app

# Build parent evisa-flow package
COPY package.json package-lock.json ./
COPY src ./src
COPY tsconfig.json ./
RUN npm ci && npx tsc --outDir dist --declaration

# Build service
WORKDIR /app/service
COPY service/package.json service/package-lock.json ./
RUN npm ci
COPY service/tsconfig.json ./
COPY service/src ./src
RUN npx tsc

CMD ["node", "dist/index.js"]
