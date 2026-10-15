FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY vendor/cinepro/package*.json ./vendor/cinepro/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && npm prune --prefix vendor/cinepro --omit=dev
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["npm", "start"]
