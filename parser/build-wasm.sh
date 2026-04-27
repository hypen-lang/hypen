#!/bin/bash
set -e

echo "Building Hypen parser WASM..."

# Check if wasm-pack is installed
if ! command -v wasm-pack &> /dev/null; then
    echo "wasm-pack not found. Installing..."
    cargo install wasm-pack
fi

# Build for Node.js (for LSP)
echo "Building for Node.js..."
wasm-pack build --target nodejs --out-dir pkg/nodejs --features wasm --no-default-features

# Build for bundlers (webpack, vite, etc.)
echo "Building for bundlers..."
wasm-pack build --target bundler --out-dir pkg/bundler --features wasm --no-default-features

# Build for web (vanilla HTML/JS)
echo "Building for web..."
wasm-pack build --target web --out-dir pkg/web --features wasm --no-default-features

echo "Done! WASM packages available in:"
echo "  - pkg/nodejs/  (for Node.js/LSP)"
echo "  - pkg/bundler/ (for webpack/vite)"
echo "  - pkg/web/     (for browsers)"
