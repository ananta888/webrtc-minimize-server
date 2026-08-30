FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY angular.json tsconfig.json ./
COPY frontend ./frontend
RUN npm run build

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY src ./src
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
