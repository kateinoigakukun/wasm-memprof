@_extern(c, "swift_demangle")
func _stdlib_demangleImpl(
  mangledName: UnsafePointer<CChar>?,
  mangledNameLength: UInt,
  outputBuffer: UnsafeMutablePointer<CChar>?,
  outputBufferSize: UnsafeMutablePointer<UInt>?,
  flags: UInt32
) -> UnsafeMutablePointer<CChar>?

@_expose(wasm, "swift_demangle")
func _stdlib_demangle(
  mangledName: UnsafePointer<CChar>?,
  mangledNameLength: UInt,
  outputBuffer: UnsafeMutablePointer<CChar>?,
  outputBufferSize: UnsafeMutablePointer<UInt>?,
  flags: UInt32
) -> UnsafeMutablePointer<CChar>? {
  return _stdlib_demangleImpl(
    mangledName: mangledName,
    mangledNameLength: mangledNameLength,
    outputBuffer: outputBuffer,
    outputBufferSize: outputBufferSize,
    flags: flags
  )
}

@_expose(wasm, "swift_malloc")
public func _stdlib_malloc(_ size: UInt) -> UnsafeMutableRawPointer? {
  return UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 1)
}

@_expose(wasm, "swift_free")
public func _stdlib_free(_ ptr: UnsafeMutableRawPointer?) {
  ptr?.deallocate()
}
