ARG SOURCE_REVISION=unknown
ARG SOURCE_TIMESTAMP=unknown

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

FROM golang:1.24-alpine AS native-packager-source
ARG SOURCE_REVISION
ARG SOURCE_TIMESTAMP
WORKDIR /src
COPY native-broadcast-packager/go.mod native-broadcast-packager/go.sum ./
RUN go mod download
COPY native-broadcast-packager ./

FROM native-packager-source AS native-packager-runtime-build
ARG SOURCE_REVISION
ARG SOURCE_TIMESTAMP
RUN linker_flags="-s -w -X main.buildRevision=${SOURCE_REVISION} -X main.buildTimestamp=${SOURCE_TIMESTAMP}" \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="$linker_flags" -o /native-broadcast-packager .

FROM native-packager-runtime-build AS native-packager-artifacts
ARG SOURCE_REVISION
ARG SOURCE_TIMESTAMP
RUN mkdir -p /out
RUN linker_flags="-s -w -X main.buildRevision=${SOURCE_REVISION} -X main.buildTimestamp=${SOURCE_TIMESTAMP}" \
    && cp /native-broadcast-packager /out/native-broadcast-packager-linux-amd64 \
    && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="$linker_flags" -o /out/native-broadcast-packager-linux-arm64 . \
    && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags="$linker_flags" -o /out/native-broadcast-packager-macos-amd64 . \
    && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="$linker_flags" -o /out/native-broadcast-packager-macos-arm64 . \
    && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="$linker_flags" -o /out/native-broadcast-packager-windows-amd64.exe .

FROM golang:1.24-alpine AS broadcast-origin-build
WORKDIR /src
COPY broadcast-hls-origin/go.mod ./
COPY broadcast-hls-origin ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /broadcast-hls-origin .

FROM scratch AS broadcast-hls-origin-runtime
COPY --from=broadcast-origin-build /broadcast-hls-origin /broadcast-hls-origin
USER 10001:10001
ENV BROADCAST_ORIGIN_ROOT=/var/lib/ananta-broadcast-output \
    BROADCAST_ORIGIN_ADDRESS=:8081
EXPOSE 8081
ENTRYPOINT ["/broadcast-hls-origin"]

FROM alpine:3.22 AS native-packager-runtime
RUN apk add --no-cache ca-certificates ffmpeg \
    && addgroup -g 10001 -S packager \
    && adduser -u 10001 -S -D -H -G packager packager \
    && mkdir -p /var/lib/ananta-native-packager /var/lib/ananta-broadcast-output \
    && chown packager:packager /var/lib/ananta-native-packager /var/lib/ananta-broadcast-output \
    && ffmpeg -hide_banner -version | grep -Eq '^ffmpeg version (n)?([6-9]|[1-9][0-9])\.'
COPY --from=native-packager-runtime-build /native-broadcast-packager /usr/local/bin/native-broadcast-packager
USER packager
ENV NATIVE_PACKAGER_CONTROL_URL=wss://webrtc.ananta.de/native-packager \
    NATIVE_PACKAGER_IDENTITY_FILE=/var/lib/ananta-native-packager/identity.pem \
    NATIVE_PACKAGER_PLATFORM=linux \
    NATIVE_PACKAGER_LABEL="Mini-PC Broadcast-Packager"
ENTRYPOINT ["/usr/local/bin/native-broadcast-packager"]

FROM node:22-alpine
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/ananta888/webrtc-minimize-server" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.licenses="BSD-3-Clause"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=media-agent-artifacts /out ./media-agent-downloads
COPY --from=native-packager-artifacts /out ./native-packager-downloads
COPY src ./src
COPY contracts ./contracts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
