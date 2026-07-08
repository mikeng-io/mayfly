# syntax=docker/dockerfile:1
# Mayfly MicroVM app image (Phase 2). AWS builds this from the uploaded zip
# during create-microvm-image, starts the launcher, and snapshots it.
# The MicroVM OS/service layer comes from --base-image-arn (al2023-*), set at
# create-microvm-image time — not here.

FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY launcher/main.go .
RUN go mod init launcher >/dev/null 2>&1 || true \
 && CGO_ENABLED=0 go build -o /launcher main.go

FROM ubuntu:22.04
# Pinned to the version proven in Phase 1; bump when needed. No build args are
# passed by create-microvm-image, so this is self-contained.
ARG RUNNER_VERSION=2.335.1
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates jq git sudo \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m runner
WORKDIR /actions-runner
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) rarch=x64 ;; arm64) rarch=arm64 ;; *) echo "unsupported $arch"; exit 1 ;; esac; \
    curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${rarch}-${RUNNER_VERSION}.tar.gz"; \
    tar xzf runner.tar.gz; rm runner.tar.gz; \
    ./bin/installdependencies.sh; \
    chown -R runner:runner /actions-runner
COPY --from=build /launcher /usr/local/bin/launcher
USER runner
EXPOSE 8080
CMD ["/usr/local/bin/launcher"]
