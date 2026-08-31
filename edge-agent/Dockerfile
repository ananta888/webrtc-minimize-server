FROM golang:1.25.7-alpine3.23@sha256:f6751d823c26342f9506c03797d2527668d095b0a15f1862cddb4d927a7a4ced AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/edge-agent .

FROM scratch
USER 65532:65532
COPY --from=build /out/edge-agent /edge-agent
EXPOSE 3478/udp 3478/tcp 49160-49259/udp
ENTRYPOINT ["/edge-agent"]
