# Minimal native image so MCP directories can start the stdio server and run
# introspection checks without booting the TypeScript runtime.
FROM rust:1.97.0-slim-bookworm AS rust-builder
WORKDIR /app
COPY rust ./rust
COPY data ./data
COPY src/data ./src/data
RUN cargo build --release --manifest-path rust/Cargo.toml -p epoch-mcp

FROM debian:bookworm-slim
COPY --from=rust-builder /app/rust/target/release/epoch-mcp /usr/local/bin/epoch-mcp
ENTRYPOINT ["/usr/local/bin/epoch-mcp"]
