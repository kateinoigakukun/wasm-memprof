export declare class SwiftDemangler {
    private instance;
    constructor(instance: WebAssembly.Instance);
    demangle(mangledName: string): string;
    /**
     * Create a new SwiftDemangler instance.
     */
    static create(): SwiftDemangler;
}
export declare function swiftDemangle(mangledName: string): string;
