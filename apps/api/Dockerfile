# CONTRACT ZERO API (Rust, Actix). Build context: apps/api.
# Migrations and level layouts are compiled into the binary; signing keys come from the
# environment (CZ_KEYS_JSON), never from the image.
FROM rust:1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY src src
COPY migrations migrations
RUN cargo build --release --bin contract-zero-api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 cz
COPY --from=build /src/target/release/contract-zero-api /usr/local/bin/contract-zero-api
USER cz
ENV RUST_LOG=info
EXPOSE 8080
CMD ["contract-zero-api"]
