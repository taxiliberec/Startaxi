FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY postgres-init.sql build.mjs server.mjs worker.js customer-api.js ./
COPY data/ ./data/
COPY Public/ ./public/
COPY Migrations/ ./migrations/
RUN npm run build
ENV NODE_ENV=production TAXI_PROXY_HTTPS=1
USER node
CMD ["node", "server.mjs"]
