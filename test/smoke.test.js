import { WMProf } from "../dist/wasm-memprof.js"
import * as fs from "fs"
import * as path from "path"
import test from 'node:test'
import { WASI } from "wasi"
import assert from "node:assert"
import { Profile } from "pprof-format"

/** @param {Profile} profile */
function resolveProfileReferences(profile) {
    /** @param {Numeric} id */
    const resolveFunction = (id) => {
        const function_ = profile.function[Number(id) - 1]
        const filename = profile.stringTable.strings[function_.filename]
        return {
            name: profile.stringTable.strings[function_.name],
            systemName: profile.stringTable.strings[function_.systemName],
            // Strip address part of wasm:// URLs (e.g. wasm://wasm/a.out.wasm-0c68f07a)
            // as it's not stable
            filename: filename.startsWith("wasm://") ? "wasm" : filename,
        }
    }
    /** @param {import("pprof-format").Line} line */
    const resolveLine = (line) => {
        return {
            function: resolveFunction(line.functionId),
            line: line.line,
        }
    }
    /** @param {Numeric} id */
    const resolveLocation = (id) => {
        const location = profile.location[Number(id) - 1]
        const lines = location.line.map(line => resolveLine(line))
        // Skip the location if its lines contain files starting with "node:"
        if (lines.some(line => line.function.filename.startsWith("node:"))) {
            return null
        }
        return {
            lines,
        }
    }
    /** @param {import("pprof-format").Sample} sample */
    const resolveSample = (sample) => {
        return {
            value: sample.value,
            locations: sample.locationId.map(id => resolveLocation(id)).filter(Boolean),
        }
    }
    return profile.sample.map(sample => resolveSample(sample))
}

test("smoke test", async () => {
    const WebAssembly = WMProf.wrap(globalThis.WebAssembly, {
      sampleRate: 1
    })
    const dirname = path.dirname(new URL(import.meta.url).pathname);
    const wasmBytes = fs.readFileSync(path.join(dirname, "cases/basic.wasm"))
    const wasi = new WASI({
        version: "preview1",
    })
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
        wasi_snapshot_preview1: wasi.wasiImport,
    })
    wasi.start(instance)
    const pprof = WMProf.get(instance).toPprof();
    
    const profile = Profile.decode(pprof);

    // Verify profile structure
    assert.strictEqual(profile.stringTable.strings[profile.periodType.type], "space");
    assert.strictEqual(profile.stringTable.strings[profile.periodType.unit], "bytes");
    assert.strictEqual(profile.period, 1);

    const samples = resolveProfileReferences(profile)
    const expected = JSON.parse(fs.readFileSync(path.join(dirname, "cases/basic.pprof.json"), "utf-8"))
    assert.deepStrictEqual(samples, expected)
})
