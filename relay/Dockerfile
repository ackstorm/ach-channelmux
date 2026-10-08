# syntax=docker/dockerfile:1.7
# ach-channelmux relay. Build from the repo root: docker build -f relay/Dockerfile .
# Node runs the TypeScript sources directly (type stripping), so there is no build
# step; the builder stage only installs the relay's production deps.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY relay/package.json ./relay/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --workspace relay

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY relay/package.json ./relay/
COPY relay/src/ ./relay/src/
# Non-root; the app writes nothing.
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["node", "relay/src/main.ts"]
