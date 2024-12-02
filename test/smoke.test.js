import { WMProf } from "../dist/wasm-memprof.js"
import * as fs from "fs"
import * as path from "path"
import test from 'node:test'
import { WASI } from "wasi"
import { execFileSync } from "child_process"

test("smoke test", async () => {
    const WebAssembly = WMProf.wrap(globalThis.WebAssembly)
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
    const tmpdir = fs.mkdtempSync(path.join(dirname, "test-"))
    const pprofPath = path.join(tmpdir, "test.pprof")
    fs.writeFileSync(pprofPath, pprof)
    execFileSync("go", ["tool", "pprof", pprofPath, "--text"])
    fs.rmSync(tmpdir, { recursive: true })
})
