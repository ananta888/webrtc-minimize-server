FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY angular.json tsconfig.json ./
COPY frontend ./frontend
COPY scripts/extract-vosk-worker.mjs ./scripts/extract-vosk-worker.mjs
COPY third_party/vosk-browser ./third_party/vosk-browser
RUN npm run build

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM golang:1.24-alpine AS media-agent-artifacts
WORKDIR /src
COPY media-edge-agent/go.mod media-edge-agent/go.sum ./
RUN go mod download
COPY media-edge-agent ./
RUN mkdir -p /out
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/media-edge-agent-linux-amd64 .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/media-edge-agent-linux-arm64 .
RUN CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/media-edge-agent-macos-amd64 .
RUN CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/media-edge-agent-macos-arm64 .
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/media-edge-agent-windows-amd64.exe .

WORKDIR /native-packager
COPY native-broadcast-packager/go.mod native-broadcast-packager/go.sum ./
RUN go mod download
COPY native-broadcast-packager ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/native-broadcast-packager-linux-amd64 .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/native-broadcast-packager-linux-arm64 .
RUN CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/native-broadcast-packager-macos-amd64 .
RUN CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/native-broadcast-packager-macos-arm64 .
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/native-broadcast-packager-windows-amd64.exe .

FROM node:22-alpine
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/ananta888/webrtc-minimize-server" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.licenses="BSD-3-Clause"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=media-agent-artifacts /out ./media-agent-downloads
RUN mkdir -p ./native-packager-downloads && mv ./media-agent-downloads/native-broadcast-packager-* ./native-packager-downloads/
COPY src ./src
COPY contracts ./contracts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
