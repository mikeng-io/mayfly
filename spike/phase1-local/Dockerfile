# syntax=docker/dockerfile:1
# Mayfly runner image (spike): GitHub Actions runner + the in-VM launcher.
# Models what will become the Lambda MicroVM image.

FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY launcher/main.go .
RUN go mod init launcher >/dev/null 2>&1 || true \
 && CGO_ENABLED=0 go build -o /launcher main.go

FROM ubuntu:22.04
ARG RUNNER_VERSION
ARG RUNNER_ARCH=x64
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates jq git sudo \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m runner
WORKDIR /actions-runner
RUN curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" \
 && tar xzf runner.tar.gz && rm runner.tar.gz \
 && ./bin/installdependencies.sh \
 && chown -R runner:runner /actions-runner
COPY --from=build /launcher /usr/local/bin/launcher
USER runner
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/launcher"]
