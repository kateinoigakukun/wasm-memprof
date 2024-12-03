// @ts-check

import * as bg from "../bindgen/pkg/wasm_memprof.js";
import init from "../bindgen/pkg/wasm_memprof.js";
import { perftools } from "./profile.pb.js";
// @ts-ignore
import bindgenWasm from "../bindgen/pkg/wasm_memprof_bg.wasm" assert { type: "binary" };

let _initBindgen: Promise<void> | undefined;

/**
 * Initialize the WebAssembly bindgen module.
 *
 * @param WebAssembly The WebAssembly object
 * @returns A promise that resolves once the bindgen module is initialized
 */
async function initBindgen(WebAssembly: typeof globalThis.WebAssembly): Promise<void> {
    if (!_initBindgen) {
        _initBindgen = (async () => {
            // @ts-ignore: We expect bindgenWasm to be a Uint8Array but
            // wasm-pack emits a d.ts for the wasm module that doesn't
            // work for us.
            const bgModule = await WebAssembly.compile(bindgenWasm);
            await init(bgModule);
        })();
    }
    return _initBindgen;
}

/**
 * Transform a WebAssembly module bytes to instrumented module bytes that
 * will call the profiler hooks.
 *
 * @param moduleBytes The original module bytes
 * @param WebAssembly The WebAssembly object
 * @returns A promise that resolves to the instrumented module bytes
 */
async function instrumentModule(moduleBytes: BufferSource, WebAssembly: typeof globalThis.WebAssembly): Promise<Uint8Array> {
    const arrayBuffer = moduleBytes instanceof ArrayBuffer ? moduleBytes : moduleBytes.buffer;
    await initBindgen(WebAssembly);
    return bg.instrument_allocator(new Uint8Array(arrayBuffer));
}

/**
 * List of functions hooked by the profiler
 */
const HOOKED_FUNCTIONS: string[] = ["malloc", "free", "calloc", "realloc", "posix_memalign", "aligned_alloc"];

/**
 * Instrument an import object by adding profiler hooks.
 *
 * @param importObject The original import object
 * @param wmprof The profiler instance
 * @returns A new import object with hooks installed
 */
function instrumentImportObject(importObject: WebAssembly.Imports | undefined, wmprof: WMProf): WebAssembly.Imports {
    const newImportObject: WebAssembly.Imports = { ...(importObject || {}) };
    newImportObject.wmprof = {};

    for (const fn of HOOKED_FUNCTIONS) {
        newImportObject.wmprof[`posthook_${fn}`] = wmprof[`posthook_${fn}`].bind(wmprof);
    }
    return newImportObject;
}

/**
 * Capture the current JavaScript stack trace.
 *
 * @returns The stack trace as an array of call sites
 */
function captureStackTrace(): NodeJS.CallSite[] {
    const e = new Error();
    const originalLimit = Error.stackTraceLimit;
    const originalPrepareStackTrace = Error.prepareStackTrace;
    Error.stackTraceLimit = 100;
    Error.prepareStackTrace = (_, stack) => stack as NodeJS.CallSite[];
    const stackTraces = e.stack as unknown as NodeJS.CallSite[];
    Error.stackTraceLimit = originalLimit;
    Error.prepareStackTrace = originalPrepareStackTrace;
    return stackTraces;
}

/**
 * An interning utility for mapping keys to unique numeric IDs and storing values.
 *
 * @template Key, Value
 */
class Interner<Key, Value> {
    private map: Map<Key, number> = new Map();
    private storage: Value[];
    private offset: number;

    /**
     * @param storage The storage array for values
     * @param offset The starting offset for IDs
     */
    constructor(storage: Value[], offset = 1) {
        this.storage = storage;
        this.offset = offset;
    }

    /**
     * Get the next available ID.
     *
     * @returns The next available ID
     */
    nextId(): number {
        return this.storage.length + this.offset;
    }

    /**
     * Intern a key and associate it with a unique ID.
     *
     * @param key The key to intern
     * @param makeItem A function to create a value for the key
     * @returns The unique ID for the key
     */
    intern(key: Key, makeItem: (id: number) => Value): number {
        const interned = this.map.get(key);
        if (interned !== undefined) {
            return interned;
        }
        const id = this.nextId();
        this.storage.push(makeItem(id));
        this.map.set(key, id);
        return id;
    }
}

/**
 * Profile builder that constructs the pprof profile format.
 */
class ProfileBuilder {
    private demangler?: (name: string) => string;
    public profile: perftools.profiles.Profile;
    private stringMap: Interner<string, string>;
    private locationMap: Interner<string, perftools.profiles.ILocation>;
    private functionMap: Interner<string, perftools.profiles.IFunction>;

    /**
     * @param options Options for the profile builder
     */
    constructor(options: { demangler?: (name: string) => string }) {
        this.demangler = options.demangler;
        this.profile = new perftools.profiles.Profile();
        this.stringMap = new Interner(this.profile.stringTable, 0);
        this.locationMap = new Interner(this.profile.location);
        this.functionMap = new Interner(this.profile.function);
        this.internString("");
    }

    finalize(): perftools.profiles.Profile {
        return this.profile;
    }

    internString(str: string): number {
        return this.stringMap.intern(str, (id) => str);
    }

    internJSFunction(callSite: NodeJS.CallSite): number {
        const fileName = callSite.getFileName();
        const name = callSite.getFunctionName();
        const key = `${fileName}:${name}`;
        return this.functionMap.intern(key, (id) => {
            const function_ = new perftools.profiles.Function();
            function_.id = id;
            if (name) {
                function_.systemName = this.internString(name);
                if (this.demangler) {
                    function_.name = this.internString(this.demangler(name));
                } else {
                    function_.name = function_.systemName;
                }
            } else {
                // 0 is reserved for empty string
                function_.name = 0;
                function_.systemName = 0;
            }
            function_.filename = this.internString(fileName || "<unknown file>");
            // TODO: Set start_line from DWARF info
            return function_
        })
    }

    internWasmFunction(callSite: NodeJS.CallSite): number {
        const functionIndex = callSite.getFunction();
        const key = `${callSite.getScriptNameOrSourceURL()}:${functionIndex}`;
        return this.functionMap.intern(key, (id) => {
            const function_ = new perftools.profiles.Function();
            function_.id = id;
            const name = callSite.getFunctionName();
            if (name) {
                function_.systemName = this.internString(name);
                if (this.demangler) {
                    function_.name = this.internString(this.demangler(name));
                } else {
                    function_.name = function_.systemName;
                }
            } else {
                // 0 is reserved for empty string
                function_.name = 0;
                function_.systemName = 0;
            }
            function_.filename = this.internString(callSite.getFileName() || "<unknown file>");
            return function_;
        })
    }

    internLocation(callSite: NodeJS.CallSite): number {
        const key = `${callSite.getFileName()}:${callSite.getLineNumber()}:${callSite.getColumnNumber()}:${callSite.getPosition()}`;
        return this.locationMap.intern(key, (id) => {
            // Two location types: JS function, wasm function
            const location = new perftools.profiles.Location();
            location.id = id;
            location.mappingId = 1; // We only have one mapping
            const isWasm = callSite.getFileName()?.startsWith("wasm://");
            if (isWasm) {
                location.address = callSite.getPosition();
                const function_ = this.internWasmFunction(callSite);
                location.line = [new perftools.profiles.Line({
                    line: callSite.getLineNumber(),
                    functionId: function_
                })]
            } else {
                const function_ = this.internJSFunction(callSite);
                location.line = [new perftools.profiles.Line({
                    line: callSite.getLineNumber(),
                    functionId: function_
                })]
            }
            return location;
        });
    }

    valueType(type: string, unit: string): perftools.profiles.ValueType {
        const valueType = new perftools.profiles.ValueType();
        valueType.type = this.internString(type);
        valueType.unit = this.internString(unit);
        return valueType;
    }
}

type WMProfOptions = {
    /**
     * The sample rate for the profiler in bytes.
     * The profiler will sample every `sampleRate` bytes allocated.
     * Lower values will result in more precise profiles but will also
     * increase the runtime overhead. Set to 1 to sample every allocation.
     *
     * @default 2048 (2kb)
     */
    sampleRate?: number,

    /**
     * The maximum number of stack frames to capture in a profile.
     *
     * @default 100
     */
    stackTraceLimit?: number,

    /**
     * A demangler function that takes a raw function name and returns the demangled name.
     *
     * @param name raw function name (typically mangled)
     * @returns demangled function name
     */
    demangler?: (name: string) => string
};

type AllocationInfo = {
    size: number;
    stack?: NodeJS.CallSite[];
};

/**
 * WebAssembly Memory Profiler
 */
export class WMProf {

    private inUseAllocations: Map<number, AllocationInfo>;
    private sampleRate: number;
    private nextSample: number;
    private options: WMProfOptions;
    private _instance?: WeakRef<WebAssembly.Instance>;
    private _initiator?: NodeJS.CallSite[];

    /**
     * @internal
     */
    constructor(options: WMProfOptions) {
        this.inUseAllocations = new Map();
        // Sample every 2kb allocation by default
        this.sampleRate = options.sampleRate || 2 * 1024;
        this.nextSample = this.sampleRate;
        this.options = options;
    }

    static #installed: WMProf[] = [];
    static #finalizationRegistry = new FinalizationRegistry<WMProf>((wmprof) => {
        const index = WMProf.#installed.indexOf(wmprof);
        if (index !== -1) {
            WMProf.#installed.splice(index, 1);
        }
    });
    static #wmprofKey = Symbol("wmprof");

    /**
     * Install the memory profiler on the given WebAssembly namespace.
     *
     * @example
     * ```js
     * import { WMProf } from 'wasm-memprof';
     * const WebAssembly = WMProf.wrap(window.WebAssembly);
     * const { instance } = await WebAssembly.instantiate(buffer);
     * instance.exports.myFunction();
     *
     * const wmprof = WMProf.get(instance);
     * wmprof.downloadSnapshot();
     * ```
     *
     * @param WebAssembly The WebAssembly object to install the profiler on
     */
    static wrap(WebAssembly: typeof globalThis.WebAssembly, options: WMProfOptions = {}): typeof globalThis.WebAssembly {
        // FIXME: It's ideal to change the limit at `captureStackTrace` but it
        // doesn't seem to work at least in V8. Setting it before starting profiling
        // seems to work.
        const MINIMUM_STACK_TRACE_LIMIT = 100;
        if (options.stackTraceLimit) {
            Error.stackTraceLimit = options.stackTraceLimit;
        } else if (Error.stackTraceLimit < MINIMUM_STACK_TRACE_LIMIT) {
            // Set a reasonable default stack trace limit if it's too low
            Error.stackTraceLimit = MINIMUM_STACK_TRACE_LIMIT;
        }

        globalThis.WMProf = WMProf;
        // Re-construct the WebAssembly object with the polyfill.
        const newWebAssembly = {};
        // Copy all properties from the original WebAssembly object.
        // Some properties are not enumerable, so we need to use Object.getOwnPropertyDescriptors.
        for (const key in Object.getOwnPropertyDescriptors(WebAssembly)) {
            newWebAssembly[key] = WebAssembly[key];
        }

        const newMethods = {
            compile: async (bufferSource) => {
                const buffer = await instrumentModule(bufferSource, WebAssembly);
                return WebAssembly.compile(buffer);
            },
            compileStreaming: async (response) => {
                const buffer = await (await response).arrayBuffer();
                const instrumented = await instrumentModule(buffer, WebAssembly);
                return WebAssembly.compile(instrumented);
            },
            instantiate: async (bufferSource, importObject) => {
                const wmprof = new WMProf(options);
                if (bufferSource instanceof WebAssembly.Module) {
                    if (!WebAssembly.Module.imports(bufferSource).find((i) => i.module === "wmprof")) {
                        // If the module was compiled without instrumentation, just ignore it.
                        // This is the case when the module was pre-compiled before enabling the profiler.
                        return WebAssembly.instantiate(bufferSource, importObject);
                    }
                    const instance = await WebAssembly.instantiate(bufferSource, instrumentImportObject(importObject, wmprof));
                    WMProf.install(instance, wmprof);
                    return instance;
                }
                const buffer = await instrumentModule(bufferSource, WebAssembly);
                const result = await WebAssembly.instantiate(buffer, instrumentImportObject(importObject, wmprof));
                WMProf.install(result.instance, wmprof);
                return result;
            },
            instantiateStreaming: async (response, importObject) => {
                const buffer = await (await response).arrayBuffer();
                const instrumented = await instrumentModule(buffer, WebAssembly);
                const wmprof = new WMProf(options);
                const result = await WebAssembly.instantiate(instrumented, instrumentImportObject(importObject, wmprof));
                WMProf.install(result.instance, wmprof);
                return result;
            }
        };

        for (const key in newMethods) {
            newWebAssembly[key] = newMethods[key];
        }

        // @ts-ignore
        return newWebAssembly;
    }

    /**
     * Returns a list of installed WMProf instances associated with WebAssembly instances
     */
    public static installed(): WMProf[] {
        return [...WMProf.#installed];
    }

    /**
     * Get the WMProf instance associated with the given WebAssembly instance.
     */
    public static get(instance: WebAssembly.Instance): WMProf {
        const wmprof = instance[WMProf.#wmprofKey];
        if (wmprof instanceof WMProf) {
            return wmprof;
        }
        throw new Error("WMProf is not installed on the instance");
    }

    private static install(instance: WebAssembly.Instance, wmprof: WMProf) {
        instance[WMProf.#wmprofKey] = wmprof;
        const initiator = captureStackTrace();
        wmprof.#setAssociatedInstance(instance, initiator);
        WMProf.#installed.push(wmprof);
        WMProf.#finalizationRegistry.register(instance, wmprof);
    }

    #setAssociatedInstance(instance: WebAssembly.Instance, initiator: NodeJS.CallSite[] | undefined) {
        this._instance = new WeakRef(instance);
        this._initiator = initiator;
    }

    public get instance(): WebAssembly.Instance {
        return this._instance?.deref();
    }
    public get initiator(): NodeJS.CallSite[] | undefined {
        return this._initiator;
    }

    /**
     * Take a snapshot of the current in-use allocations.
     * Returns a pprof profile protobuf message.
     */
    public snapshot(): Uint8Array {
        const b = new ProfileBuilder(this.options);
        b.profile.periodType = b.valueType("space", "bytes");
        b.profile.period = this.sampleRate;
        b.profile.sampleType.push(b.valueType("inuse_space", "bytes"));
        const mapping = new perftools.profiles.Mapping({
            id: 1
        })
        b.profile.mapping.push(mapping);

        // Skip some internal functions from the stack
        const shouldSkip = (callSite: NodeJS.CallSite): boolean => {
            const fileName = callSite.getFileName();
            if (fileName?.includes("wasm-memprof.js")) {
                return true;
            }
            const funcName = callSite.getFunctionName();
            for (const hook of HOOKED_FUNCTIONS) {
                if (funcName === `hooked_${hook}`) {
                    return true;
                }
            }
            return false;
        }

        // Construct samples
        for (const [_, { size, stack: _stack }] of this.inUseAllocations) {
            const stack = _stack || [];
            const sample = new perftools.profiles.Sample();
            sample.value.push(size);
            for (const callSite of stack) {
                if (shouldSkip(callSite)) {
                    continue;
                }
                const loc = b.internLocation(callSite);
                sample.locationId.push(loc);
            }
            b.profile.sample.push(sample);
        }

        return perftools.profiles.Profile.encode(b.finalize()).finish();
    }

    /**
     * Download the current snapshot as a protobuf file.
     */
    public downloadSnapshot() {
        const buffer = this.snapshot();
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `wmprof-${Date.now()}.pb`;
        a.click();
        URL.revokeObjectURL(url);
    }

    private sampleAllocation(size: number, ptr: number) {
        if (this.nextSample < size) {
            const stack = captureStackTrace()
            if (!stack) {
                return;
            }
            this.nextSample = this.sampleRate;
            this.inUseAllocations.set(ptr, { size, stack });
        }
        this.nextSample -= size;
    }


    // MARK: Hooks
    // These functions are called by the instrumented WebAssembly module.

    private posthook_malloc(size: number, ptr: number) {
        if (size === 0 || ptr === 0) {
            return;
        }
        this.sampleAllocation(size, ptr);
    }

    private posthook_free(ptr: number) {
        this.inUseAllocations.delete(ptr);
    }

    private posthook_calloc(ntimes: number, size: number, ptr: number) {
        const totalSize = size * ntimes;
        if (totalSize === 0 || ptr === 0) {
            return;
        }
        this.sampleAllocation(size * ntimes, ptr);
    }

    private posthook_realloc(ptr: number, size: number, newPtr: number) {
        const info = this.inUseAllocations.get(ptr);
        if (info) {
            this.inUseAllocations.delete(ptr);
            this.sampleAllocation(size, newPtr);
        }
    }

    private posthook_posix_memalign(ptr: number, alignment: number, size: number, newPtr: number) {
        const info = this.inUseAllocations.get(ptr);
        if (info) {
            this.inUseAllocations.delete(ptr);
            this.sampleAllocation(size, newPtr);
        }
    }

    private posthook_aligned_alloc(alignment: number, size: number, newPtr: number) {
        this.sampleAllocation(size, newPtr);
    }
}
