bindgen:
	wasm-pack build --target web ./bindgen
	node bindgen/patch.mjs

build:
	npx esbuild src/wasm-memprof.ts --bundle --format=esm --outfile=dist/wasm-memprof.js --loader:.wasm=binary
	npx tsc --project tsconfig.json

build-plugins:
	swift build --package-path ./src/plugins/swift-demangler --swift-sdk DEVELOPMENT-SNAPSHOT-2024-11-24-a-wasm32-unknown-wasi -c release
	wasm-opt -Oz src/plugins/swift-demangler/.build/release/swift-demangler.wasm -o src/plugins/swift-demangler/.build/release/swift-demangler.wasm
	npx esbuild src/plugins/swift-demangler.ts --bundle --format=esm \
	    --outfile=dist/plugins/swift-demangler.js --loader:.wasm=binary

update-examples:
	$(if $(WASI_SDK_PATH),,$(error WASI_SDK_PATH is not set))
	$(WASI_SDK_PATH)/bin/clang examples/main.c -o examples/a.out.wasm -g

all: proto bindgen build

.PHONY: proto bindgen build-plugins build update-examples
