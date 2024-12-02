use instrumentor::instrument;

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        println!("[{}] {}", record.level(), record.args());
    }

    fn flush(&self) {}
}

fn main() {
    let args = std::env::args().collect::<Vec<String>>();
    if args.len() != 2 {
        eprintln!("Usage: {} <wasm_file>", args[0]);
        std::process::exit(1);
    }

    log::set_max_level(log::LevelFilter::Info);
    log::set_logger(&Logger).unwrap();

    let wasm_file = &args[1];
    let bytes = std::fs::read(wasm_file).expect("Failed to read wasm file");
    let instrumented_bytes = instrument(bytes, &instrumentor::allocator_tracees())
        .expect("Failed to instrument wasm file");
    let instrumented_file = format!("{}.instrumented", wasm_file);
    std::fs::write(&instrumented_file, instrumented_bytes)
        .expect("Failed to write instrumented file");
}
