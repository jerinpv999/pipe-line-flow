# Build context: repository root  (docker build -f agent/Dockerfile .)
# Note: in a container, steps run inside the container. To deploy onto the host itself,
# prefer the systemd install (cicd-agent.service) or mount what you need (e.g. the docker socket).
FROM node:20-alpine
RUN apk add --no-cache bash git openssh-client curl rsync docker-cli docker-cli-compose
ENV NODE_ENV=production
WORKDIR /app
COPY agent/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY agent/src ./src
COPY proto ./proto
ENV AGENT_WORKSPACE=/workspace
VOLUME /workspace
CMD ["node", "src/index.js"]
