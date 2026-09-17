# DB Client 同步服务镜像
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
COPY apps/server/package.json apps/server/
RUN npm install -g pnpm && pnpm install --filter @db-client/server
COPY apps/server apps/server
RUN pnpm --filter @db-client/server run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/package.json ./package.json
RUN npm install --omit=dev
EXPOSE 3000
CMD ["node", "dist/index.js"]