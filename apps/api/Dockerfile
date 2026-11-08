# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM rust:1.88-slim AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
# Cache dependency build layer
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src

COPY src ./src
# migrate.rs embeds migrations/*.sql into the binary via include_str! — the folder
# MUST be in the build context or every include_str! fails to compile (this is what
# broke the build after auto-migrate shipped: src was copied, migrations/ was not).
COPY migrations ./migrations
# Touch main.rs so cargo rebuilds the binary (not just deps)
RUN touch src/main.rs && cargo build --release

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/contract-zero-api ./contract-zero-api

EXPOSE 8080

CMD ["./contract-zero-api"]
