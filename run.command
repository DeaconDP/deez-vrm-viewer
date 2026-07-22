#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 20+ is required."; read -r; exit 1; }
command -v cargo >/dev/null || { echo "Rust toolchain (cargo) is required. See https://rustup.rs/"; read -r; exit 1; }
if [ ! -d node_modules ]; then
  echo "Installing..."
  npm install || { read -r; exit 1; }
fi
npm run tauri:dev
status=$?
if [ $status -ne 0 ]; then read -r; fi
exit $status
