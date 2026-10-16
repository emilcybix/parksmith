FROM mcr.microsoft.com/devcontainers/base:bookworm

RUN apt-get update && apt-get install -y \
    bash \
    curl \
    wget \
    ca-certificates \
    jq \
    ripgrep \
    fd-find \
    tree \
    make \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

USER vscode

WORKDIR /workspace