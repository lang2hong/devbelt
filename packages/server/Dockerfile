# DB Client 同步服务镜像
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
COPY packages/server/package.json packages/server/
RUN npm install -g pnpm && pnpm install --filter @db-client/server
COPY packages/server packages/server
RUN pnpm --filter @db-client/server run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/server/package.json ./package.json
RUN npm install --omit=dev
EXPOSE 3000
CMD ["node", "dist/index.js"]