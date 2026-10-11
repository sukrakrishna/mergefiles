# NOTE: written for deployment but NOT built or run in the environment where MergeAnyFile was developed.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY server/package*.json server/
COPY client/package*.json client/
RUN npm --prefix server ci && npm --prefix client ci
COPY server server
COPY client client
RUN npm --prefix client run build && npm --prefix server run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      ghostscript qpdf fonts-liberation fonts-dejavu-core fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
ENV NODE_ENV=production PORT=3001 DATA_DIR=/data
COPY --from=build /app/server/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server/dist dist
COPY --from=build /app/client/dist ../client/dist
RUN useradd -m -u 10001 app && mkdir /data && chown app /data
USER app
EXPOSE 3001
CMD ["node", "dist/index.js"]
