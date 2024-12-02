# swift-demangler

This directory contains a Swift demangler compiled to WebAssembly to demangle Swift symbols appearing in stack traces.

We currently commit a pre-bundled JS file that contains the demangler binary and the JS glue code (see `dist/plugins/swift-demangler.js`).

To rebuild the JS module, run the following commands in the root directory of the repository:

```sh
make build-plugins
```

## Prerequisites

- Swift nightly toolchain (`swift-DEVELOPMENT-SNAPSHOT-2024-11-20-a`)
- Swift SDK for WebAssembly (`DEVELOPMENT-SNAPSHOT-2024-11-24-a-wasm32-unknown-wasi`)
