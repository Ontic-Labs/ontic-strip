FROM node:20-slim AS builder
WORKDIR /app
COPY worker/package.json worker/package-lock.json* ./
RUN npm ci
COPY worker/tsconfig.json ./
COPY worker/src/ src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY worker/package.json worker/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
USER node
CMD ["node", "--enable-source-maps", "dist/worker.js"]
