FROM golang:1.24.13-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS build
WORKDIR /fixture
COPY go.mod main.go ./
RUN --network=none CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -buildvcs=false -ldflags="-s -w" -o /machine-tls-proxy .

# Keep the existing test container OS/tools for its bounded failure-only proc
# reader. Only PID1's executable changes; no Node startup or cache warmup.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ENV GOMAXPROCS=1
COPY --from=build /machine-tls-proxy /usr/local/bin/machine-tls-proxy
ENTRYPOINT ["/usr/local/bin/machine-tls-proxy"]
