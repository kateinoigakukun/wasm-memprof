import { WMProf } from "../dist/wasm-memprof.js"
import * as fs from "fs"
import * as path from "path"
import test from 'node:test'
import { WASI } from "wasi"
import { execFileSync } from "child_process"
import assert from "node:assert"

test("smoke test", async () => {
    const WebAssembly = WMProf.wrap(globalThis.WebAssembly, {
      sampleRate: 1
    })
    const dirname = path.dirname(new URL(import.meta.url).pathname);
    const wasmBytes = fs.readFileSync(path.join(dirname, "../examples/a.out.wasm"))
    const wasi = new WASI({
        version: "preview1",
    })
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
        wasi_snapshot_preview1: wasi.wasiImport,
    })
    wasi.start(instance)
    const pprof = WMProf.get(instance).snapshot();
    const tmpdir = fs.mkdtempSync(path.join(dirname, "tmp-"))
    const pprofPath = path.join(tmpdir, "test.pprof")
    fs.writeFileSync(pprofPath, pprof)
    const result = execFileSync("go", ["tool", "pprof", "--raw", pprofPath])

    const expected = `PeriodType: space bytes
Period: 1
Samples:
inuse_space/bytes
          4: 1 2 3 4 5 6 
          4: 7 8 3 4 5 6 
          4: 1 9 8 3 4 5 6 
Locations
     1: 0x1f0a M=1 foo wasm://wasm/a.out.wasm-89890da2:1:0 s=0
     2: 0x1e71 M=1 __original_main wasm://wasm/a.out.wasm-89890da2:1:0 s=0
     3: 0x1fa6 M=1 _start wasm://wasm/a.out.wasm-89890da2:1:0 s=0
     4: 0x0 M=1 start node:wasi:114:0 s=0
     5: 0x0 M=1 run node:internal/test_runner/test:632:0 s=0
     6: 0x0 M=1 startSubtest node:internal/test_runner/harness:214:0 s=0
     7: 0x1eb6 M=1 bar wasm://wasm/a.out.wasm-89890da2:1:0 s=0
     8: 0x1e74 M=1 __original_main wasm://wasm/a.out.wasm-89890da2:1:0 s=0
     9: 0x1ed3 M=1 bar wasm://wasm/a.out.wasm-89890da2:1:0 s=0
Mappings
1: 0x0/0x0/0x0   
`
    assert.strictEqual(result.toString(), expected)
    fs.rmSync(tmpdir, { recursive: true })
})
