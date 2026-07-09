# syntax=docker/dockerfile:1
# Mayfly Docker-in-MicroVM app image (Phase 2b). Runner + dockerd, run as root.
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY launcher/main.go .
RUN go mod init launcher >/dev/null 2>&1 || true && CGO_ENABLED=0 go build -o /launcher main.go

FROM ubuntu:22.04
ARG RUNNER_VERSION=2.335.1
ENV DEBIAN_FRONTEND=noninteractive RUNNER_ALLOW_RUNASROOT=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates jq git sudo docker.io iptables uidmap \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /actions-runner
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) rarch=x64 ;; arm64) rarch=arm64 ;; *) echo "unsupported $arch"; exit 1 ;; esac; \
    curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${rarch}-${RUNNER_VERSION}.tar.gz"; \
    tar xzf runner.tar.gz; rm runner.tar.gz; \
    ./bin/installdependencies.sh
COPY --from=build /launcher /usr/local/bin/launcher
EXPOSE 8080
# Run as root so dockerd + the runner (RUNNER_ALLOW_RUNASROOT) work.
CMD ["/usr/local/bin/launcher"]
