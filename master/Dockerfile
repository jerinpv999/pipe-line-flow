# Build context: repository root  (docker build -f master/Dockerfile .)
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY master/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY master/src ./src
COPY proto ./proto
COPY --from=web /web/dist ./public
EXPOSE 4000 50051
CMD ["node", "src/index.js"]
