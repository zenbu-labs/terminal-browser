
default:
    @just --list

# Install the dev tools this repo's recipes rely on (idempotent)
setup:
    brew install just bacon cargo-nextest cargo-deny || cargo install --locked bacon cargo-nextest cargo-deny

build:
    cargo build --workspace

# Type-check everything without producing binaries (fastest feedback)
check:
    cargo check --workspace --all-targets

test:
    cargo nextest run --workspace

# Clippy with warnings as errors, plus formatting check
lint:
    cargo clippy --workspace --all-targets -- -D warnings
    cargo fmt --all --check

fmt:
    cargo fmt --all

# Auto-apply clippy suggestions and formatting
fix:
    cargo clippy --workspace --all-targets --fix --allow-dirty --allow-staged
    cargo fmt --all

# Run an example app: `just run counter`
run app *args:
    cargo run -p {{app}} -- {{args}}

# Re-check on every save (bacon; press `t` for tests, `c` for clippy)
watch:
    bacon

# Audit dependencies: licenses, advisories, duplicate versions, sources
deny:
    cargo deny check

doc:
    cargo doc --workspace --no-deps --open
