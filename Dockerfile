# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

# stdio has no meaning in a container, so the image defaults to the HTTP transport.
ENV NODE_ENV=production \
    MONEYBIRD_TRANSPORT=http \
    MONEYBIRD_HOST=0.0.0.0 \
    PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY spec/endpoints.json ./spec/endpoints.json

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1

ENTRYPOINT ["node", "dist/bin.js"]
CMD ["serve"]
