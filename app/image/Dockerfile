# syntax=docker/dockerfile:1
#
# Mayfly MicroVM runner image. Two build targets from one file:
#   docker build --target runner ...   # lean, non-root (default)
#   docker build --target docker ...   # + dockerd-in-VM (root; for docker build/run + services:)
#
# AWS builds this from the uploaded context during create-microvm-image and
# snapshots the started launcher. The MicroVM OS layer comes from --base-image-arn
# (al2023 aarch64) at image-create time. Build arm64 with --platform linux/arm64.

FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY runtime/launcher/main.go .
RUN go mod init launcher >/dev/null 2>&1 || true \
 && CGO_ENABLED=0 go build -o /launcher main.go

# --- common runner base ---
FROM ubuntu:22.04 AS base
ARG RUNNER_VERSION=2.335.1
ENV DEBIAN_FRONTEND=noninteractive RUNNER_ALLOW_RUNASROOT=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates jq git sudo \
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

# --- docker-capable: dockerd-in-VM, runs as root (RUNNER_ALLOW_RUNASROOT). Build with --target docker ---
FROM base AS docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io iptables uidmap \
 && rm -rf /var/lib/apt/lists/*
CMD ["/usr/local/bin/launcher"]

# --- lean runner: non-root, no docker. LAST stage => the default build target ---
# (AWS create-microvm-image builds the final stage; keep the lean image as the v1 default.)
FROM base AS runner
RUN useradd -m runner && chown -R runner:runner /actions-runner
USER runner
CMD ["/usr/local/bin/launcher"]
