import * as bg from "../bindgen/pkg/wasm_memprof.js";
import init from "../bindgen/pkg/wasm_memprof.js";
import { Profile, Location, Function, StringTable, Line, ValueType, Mapping, Sample } from "pprof-format";
// @ts-ignore
import bindgenWasm from "../bindgen/pkg/wasm_memprof_bg.wasm" assert { type: "binary" };

type Bindgen = {
    instrument_allocator: (moduleBytes: Uint8Array) => Promise<Uint8Array>
}
let _initBindgen: Promise<Bindgen> | undefined;

/**
 * Initialize the WebAssembly bindgen module.
 *
 * @param WebAssembly The original WebAssembly object
 * @param options Options for the profiler
 * @returns A promise that resolves once the bindgen module is initialized
 */
async function initBindgen(WebAssembly: typeof globalThis.WebAssembly, options: WMProfOptions): Promise<Bindgen> {
    // Use Web Worker if available and not disabled by the user for the
    // following reasons:
    //
    // 1. The instrumentor is a heavy operation and can block the main
    //    thread for a long time.
    // 2. When the tracee module is very large, the instrumentor consumes
    //    a lot of memory. However, even if the instrumentor calls `free`, the
    //    Wasm memory space will not be shrunk due to the limitation of Wasm
    //    itself. Therefore, the only way to deallocate the Wasm memory space is
    //    to deallocate the WebAssembly instance itself.
    //    However, glue code generated by wasm-bindgen does not expose a way to
    //    deallocate the WebAssembly instance. So, we use a Web Worker to
    //    isolate the JS memory space and deallocate the Worker instance to free
    //    the Wasm instance.

    if (typeof Worker === "undefined" || !(options.useWorker ?? true)) {
        const bindgen = await __initBindgen(WebAssembly);
        return bindgen;
    }

    const workerScript = `
            onmessage = async (e) => {
                const { selfScript, bytes } = e.data;
                const { __initBindgen } = await import(selfScript);
                const bindgen = await __initBindgen(globalThis.WebAssembly);
                const instrumented = await bindgen.instrument_allocator(bytes);
                postMessage(instrumented, [instrumented.buffer]);
            }
        `;
    const blob = new Blob([workerScript], { type: "application/javascript" });
    return {
        async instrument_allocator(moduleBytes: Uint8Array): Promise<Uint8Array> {
            const worker = new Worker(URL.createObjectURL(blob));
            return new Promise((resolve, reject) => {
                worker.onmessage = (e) => {
                    resolve(e.data);
                    worker.terminate();
                }
                worker.onerror = (e) => {
                    reject(e);
                }
                worker.postMessage({
                    selfScript: import.meta.url,
                    bytes: moduleBytes
                });
            });
        }
    }
}

export async function __initBindgen(WebAssembly: typeof globalThis.WebAssembly) {
    if (!_initBindgen) {
        _initBindgen = (async () => {
            // @ts-ignore: We expect bindgenWasm to be a Uint8Array but
            // wasm-pack emits a d.ts for the wasm module that doesn't
            // work for us.
            const bgModule = await WebAssembly.compile(bindgenWasm);
            await init(bgModule);
            return {
                async instrument_allocator(moduleBytes: Uint8Array): Promise<Uint8Array> {
                    return bg.instrument_allocator(moduleBytes);
                }
            }
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
async function instrumentModule(moduleBytes: BufferSource, WebAssembly: typeof globalThis.WebAssembly, options: WMProfOptions): Promise<Uint8Array> {
    const arrayBuffer = moduleBytes instanceof ArrayBuffer ? moduleBytes : moduleBytes.buffer;
    const bg = await initBindgen(WebAssembly, options);
    return await bg.instrument_allocator(new Uint8Array(arrayBuffer));
}

/**
 * List of functions hooked by the profiler
 */
const HOOKED_FUNCTIONS: string[] = ["malloc", "dlmalloc", "free", "dlfree", "calloc", "dlcalloc", "realloc", "dlrealloc", "posix_memalign", "dlposix_memalign", "aligned_alloc", "dlaligned_alloc"];

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
    public profile: Profile;
    private stringMap: StringTable;
    private locationMap: Interner<string, Location>;
    private functionMap: Interner<string, Function>;

    /**
     * @param options Options for the profile builder
     */
    constructor(options: { demangler?: (name: string) => string }) {
        this.demangler = options.demangler;
        this.profile = new Profile();
        this.stringMap = this.profile.stringTable;
        this.locationMap = new Interner(this.profile.location);
        this.functionMap = new Interner(this.profile.function);
        this.internString("");
    }

    finalize(): Profile {
        return this.profile;
    }

    internString(str: string): number {
        return this.stringMap.dedup(str);
    }

    internJSFunction(callSite: SerializedCallSite): number {
        const fileName = callSite.fileName;
        const name = callSite.functionName;
        const key = `${fileName}:${name}`;
        return this.functionMap.intern(key, (id) => {
            const function_ = new Function({ id });
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

    internWasmFunction(callSite: SerializedCallSite): number {
        const key = `${callSite.fileName}:${callSite.functionName}`;
        return this.functionMap.intern(key, (id) => {
            const function_ = new Function({ id });
            const name = callSite.functionName;
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
            function_.filename = this.internString(callSite.fileName || "<unknown file>");
            return function_;
        })
    }

    internLocation(callSite: SerializedCallSite): number {
        const key = `${callSite.fileName}:${callSite.lineNumber}:${callSite.columnNumber}:${callSite.position}`;
        return this.locationMap.intern(key, (id) => {
            // Two location types: JS function, wasm function
            const location = new Location({ id });
            location.mappingId = 1; // We only have one mapping
            const isWasm = callSite.fileName?.startsWith("wasm://");
            if (isWasm) {
                location.address = callSite.position;
                const function_ = this.internWasmFunction(callSite);
                location.line = [new Line({
                    line: callSite.lineNumber,
                    functionId: function_
                })]
            } else {
                const function_ = this.internJSFunction(callSite);
                location.line = [new Line({
                    line: callSite.lineNumber,
                    functionId: function_
                })]
            }
            return location;
        });
    }

    valueType(type: string, unit: string): ValueType {
        const valueType = new ValueType({
            type: this.internString(type),
            unit: this.internString(unit)
        });
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
    demangler?: (name: string) => string,

    /**
     * Use Web Worker to isolate the instrumentor from the main thread.
     *
     * @default true
     */
    useWorker?: boolean
};

type AllocationInfo<CallSite> = {
    size: number;
    stack?: CallSite[];
};

/**
 * A map of in-use allocations.
 * The key is the pointer to the allocation.
 */
type InUseAllocations<CallSite> = Map<number, AllocationInfo<CallSite>>;

type SerializedCallSite = {
    fileName: string | undefined;
    lineNumber: number | null;
    columnNumber: number | null;
    position: number;
    functionName: string | null;
}

/**
 * A snapshot of the current in-use allocations.
 */
class Snapshot {
    #inUseAllocations: InUseAllocations<SerializedCallSite>;

    /**
     * @internal
     */
    constructor(inUseAllocations: InUseAllocations<SerializedCallSite>) {
        this.#inUseAllocations = inUseAllocations;
    }

    /**
     * Merge multiple snapshots into a single snapshot.
     *
     * @param snapshots The snapshots to merge
     * @returns The merged snapshot
     */
    static merge(snapshots: Snapshot[]): Snapshot {
        const inUseAllocations: InUseAllocations<SerializedCallSite> = new Map();
        for (const snapshot of snapshots) {
            for (const [ptr, { size, stack: _stack }] of snapshot.#inUseAllocations) {
                inUseAllocations.set(ptr, { size, stack: _stack });
            }
        }
        return new Snapshot(inUseAllocations);
    }

    /**
     * Convert the snapshot to a structured-cloneable object.
     * This is useful for transferring the snapshot to another thread.
     *
     * @returns An opaque structured-cloneable object
     */
    transfer(): unknown {
        return this.#inUseAllocations;
    }

    /**
     * Restore a snapshot from a structured-cloneable object.
     *
     * @param snapshot The opaque structured-cloneable object, which is
     * returned by `transfer`.
     * @returns The restored snapshot
     */
    static restore(snapshot: unknown): Snapshot {
        return new Snapshot(snapshot as InUseAllocations<SerializedCallSite>);
    }

    /**
     * Serialize the snapshot to a pprof protobuf message.
     *
     * @param options The WMProf options
     * @param sampleRate The sample rate
     * @returns The pprof protobuf message
     */
    toPprof(options: { demangler?: (name: string) => string }, sampleRate: number): Uint8Array {
        const serializer = Snapshot.toPprofSerializer(options, sampleRate);
        for (const [ptr, { size, stack }] of this.#inUseAllocations) {
            serializer.addSample(ptr, size, stack);
        }
        return serializer.finalize();
    }

    /**
     * @internal
     */
    static toPprofSerializer(options: { demangler?: (name: string) => string }, sampleRate: number): {
        addSample: (ptr: number, size: number, stack: SerializedCallSite[]) => void;
        finalize: () => Uint8Array;
    } {
        const b = new ProfileBuilder(options);
        b.profile.periodType = b.valueType("space", "bytes");
        b.profile.period = sampleRate;
        b.profile.sampleType.push(b.valueType("inuse_space", "bytes"));
        const mapping = new Mapping({
            id: 1
        })
        b.profile.mapping.push(mapping);

        return {
            addSample: (ptr: number, size: number, stack: SerializedCallSite[]) => {
                const sample = new Sample({
                    value: [size]
                });
                for (const callSite of stack) {
                    const loc = b.internLocation(callSite);
                    sample.locationId.push(loc);
                }
                b.profile.sample.push(sample);
            },
            finalize: () => b.profile.encode()
        }
    }
}

/**
 * WebAssembly Memory Profiler
 */
export class WMProf {
    /**
     * The Snapshot class.
     *
     * @see Snapshot
     */
    static Snapshot = Snapshot;

    private inUseAllocations: InUseAllocations<NodeJS.CallSite>;
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
                const buffer = await instrumentModule(bufferSource, WebAssembly, options);
                return WebAssembly.compile(buffer);
            },
            compileStreaming: async (response) => {
                const buffer = await (await response).arrayBuffer();
                const instrumented = await instrumentModule(buffer, WebAssembly, options);
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
                const buffer = await instrumentModule(bufferSource, WebAssembly, options);
                const result = await WebAssembly.instantiate(buffer, instrumentImportObject(importObject, wmprof));
                WMProf.install(result.instance, wmprof);
                return result;
            },
            instantiateStreaming: async (response, importObject) => {
                const buffer = await (await response).arrayBuffer();
                const instrumented = await instrumentModule(buffer, WebAssembly, options);
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

    static #shouldSkip(callSite: NodeJS.CallSite): boolean {
        // Skip some internal functions from the stack
        const fileName = callSite.getFileName();
        // Skip functions from the profiler itself
        // NOTE: The filename might not be "wasm-memprof.js" as is if
        // the code is bundled. Thus, we loosely check here.
        if (fileName?.includes("wasm-memprof")) {
            return true;
        }
        // Skip hooked allocator functions
        const funcName = callSite.getFunctionName();
        for (const hook of HOOKED_FUNCTIONS) {
            if (funcName === `hooked_${hook}`) {
                return true;
            }
        }
        return false;
    }

    static #serializeCallSite(callSite: NodeJS.CallSite): SerializedCallSite {
        return {
            fileName: callSite.getFileName(),
            lineNumber: callSite.getLineNumber(),
            columnNumber: callSite.getColumnNumber(),
            position: callSite.getPosition(),
            functionName: callSite.getFunctionName(),
        };
    }

    /**
     * Take a snapshot of the current in-use allocations.
     * Returns a pprof profile protobuf message.
     */
    public toPprof(): Uint8Array {
        const serializer = Snapshot.toPprofSerializer(this.options, this.sampleRate);
        // Construct samples
        for (const [ptr, { size, stack }] of this.inUseAllocations) {
            const serializedStack: SerializedCallSite[] = [];
            for (const callSite of stack) {
                if (WMProf.#shouldSkip(callSite)) {
                    continue;
                }
                serializedStack.push(WMProf.#serializeCallSite(callSite));
            }
            serializer.addSample(ptr, size, serializedStack);
        }

        return serializer.finalize();
    }

    /**
     * Take a snapshot of the current in-use allocations.
     * Returns a Snapshot object, which can be merged with other snapshots.
     */
    public snapshot(): Snapshot {
        const inUseAllocations: InUseAllocations<SerializedCallSite> = new Map();
        for (const [ptr, { size, stack }] of this.inUseAllocations) {
            const serializedStack: SerializedCallSite[] = [];
            for (const callSite of stack) {
                if (WMProf.#shouldSkip(callSite)) {
                    continue;
                }
                serializedStack.push(WMProf.#serializeCallSite(callSite));
            }
            inUseAllocations.set(ptr, { size, stack: serializedStack });
        }
        return new Snapshot(inUseAllocations);
    }

    /**
     * Serialize the snapshot to a pprof protobuf message.
     *
     * @param main The main WMProf instance
     * @param snapshot The snapshot to serialize
     * @returns The pprof protobuf message
     */
    static toPprof(main: WMProf, snapshot: Snapshot): Uint8Array {
        return snapshot.toPprof(main.options, main.sampleRate);
    }

    /**
     * Download snapshots of all installed profilers as protobuf files.
     */
    public static downloadAllSnapshots() {
        for (const wmprof of WMProf.#installed) {
            wmprof.downloadSnapshot();
        }
    }

    /**
     * Download the current snapshot as a protobuf file.
     */
    public downloadSnapshot() {
        const buffer = this.toPprof();
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
    
    private posthook_dlmalloc(size: number, ptr: number) {
        this.posthook_malloc(size, ptr);
    }

    private posthook_free(ptr: number) {
        this.inUseAllocations.delete(ptr);
    }

    private posthook_dlfree(ptr: number) {
        this.posthook_free(ptr);
    }

    private posthook_calloc(ntimes: number, size: number, ptr: number) {
        const totalSize = size * ntimes;
        if (totalSize === 0 || ptr === 0) {
            return;
        }
        this.sampleAllocation(size * ntimes, ptr);
    }

    private posthook_dlcalloc(ntimes: number, size: number, ptr: number) {
        this.posthook_calloc(ntimes, size, ptr);
    }

    private posthook_realloc(ptr: number, size: number, newPtr: number) {
        const info = this.inUseAllocations.get(ptr);
        if (info) {
            this.inUseAllocations.delete(ptr);
        }
        this.sampleAllocation(size, newPtr);
    }

    private posthook_dlrealloc(ptr: number, size: number, newPtr: number) {
        this.posthook_realloc(ptr, size, newPtr);
    }

    private posthook_posix_memalign(ptr: number, alignment: number, size: number, newPtr: number) {
        const info = this.inUseAllocations.get(ptr);
        if (info) {
            this.inUseAllocations.delete(ptr);
        }
        this.sampleAllocation(size, newPtr);
    }

    private posthook_dlposix_memalign(ptr: number, alignment: number, size: number, newPtr: number) {
        this.posthook_posix_memalign(ptr, alignment, size, newPtr);
    }

    private posthook_aligned_alloc(alignment: number, size: number, newPtr: number) {
        this.sampleAllocation(size, newPtr);
    }

    private posthook_dlaligned_alloc(alignment: number, size: number, newPtr: number) {
        this.posthook_aligned_alloc(alignment, size, newPtr);
    }
}
