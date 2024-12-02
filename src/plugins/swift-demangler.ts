// @ts-ignore
import wasm from "./swift-demangler/.build/release/swift-demangler.wasm" assert { type: "binary" }

export class SwiftDemangler {
  private instance: WebAssembly.Instance;

  constructor(instance: WebAssembly.Instance) {
    this.instance = instance;
  }

  public demangle(mangledName: string): string {
    type Exports = {
      swift_demangle: (buffer: number, length: number, outputBuffer: number, outputLength: number, flags: number) => number,
      swift_malloc: (size: number) => number,
      swift_free: (pointer: number) => void,
      memory: WebAssembly.Memory,
    }
    const { swift_demangle, swift_malloc, swift_free, memory } = this.instance.exports as Exports;
    const encoded = new TextEncoder().encode(mangledName);
    const buffer = swift_malloc(encoded.length);
    let view = new Uint8Array(memory.buffer);
    view.set(encoded, buffer);
    const demangled = swift_demangle(buffer, encoded.length, 0, 0, 0);
    swift_free(buffer);

    if (demangled === 0) {
      return mangledName;
    }

    view = new Uint8Array(memory.buffer);
    let demangledEnd = demangled;
    while (demangledEnd < view.length && view.at(demangledEnd) !== 0) {
      demangledEnd++;
    }
    const decoded = new TextDecoder().decode(view.slice(demangled, demangledEnd));
    swift_free(demangled);
    return decoded;
  }

  /**
   * Create a new SwiftDemangler instance.
   */
  public static create(): SwiftDemangler {
    const module = new WebAssembly.Module(wasm);
    const wasip1 = {}
    for (const importEntry of WebAssembly.Module.imports(module)) {
      if (importEntry.module === "wasi_snapshot_preview1") {
        const name = importEntry.name;
        wasip1[name] = () => {
          throw new Error(`swift-demangler: WASI function ${name} is not implemented`);
        };
      }
    }
    const instance = new WebAssembly.Instance(module, {
      wasi_snapshot_preview1: wasip1,
    });
    return new SwiftDemangler(instance);
  }
}

export function swiftDemangle(mangledName: string): string {
  const demangler = SwiftDemangler.create();
  return demangler.demangle(mangledName);
}
