FROM rust:1.88-slim-trixie

RUN apt-get update && apt-get install -y \
    curl \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN curl -L https://codeload.github.com/getlago/lago-agent-toolkit/tar.gz/refs/heads/main \
  | tar -xz --strip-components=1

WORKDIR /src/mcp

RUN cargo build --release

ENV RUST_LOG=info

CMD ["./target/release/lago-mcp-server", "sse", "--host", "0.0.0.0", "--port", "3001"]
