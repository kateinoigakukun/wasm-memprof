proto/profile.proto:
	mkdir -p proto
	curl -o proto/profile.proto "https://raw.githubusercontent.com/google/pprof/dc51965c6481d757c5a4d8809bdebbe4bb4841ac/proto/profile.proto"

src/profile.pb.js: proto/profile.proto
	npx pbjs --target static-module --wrap es6 proto/profile.proto -o src/profile.pb.js

src/profile.pb.d.ts: src/profile.pb.js
	npx pbts -o src/profile.proto.d.ts src/profile.pb.js

proto: src/profile.pb.js src/profile.pb.d.ts

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
