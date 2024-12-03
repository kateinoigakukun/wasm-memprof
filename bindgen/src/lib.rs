use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        log(&format!(
            "[wasm-memprof][{}] {}",
            record.level(),
            record.args()
        ));
    }

    fn flush(&self) {}
}

static mut INITIALIZED: bool = false;

fn init_once() {
    if unsafe { INITIALIZED } {
        return;
    }
    unsafe {
        INITIALIZED = true;
    }
    log::set_logger(&Logger).unwrap();
    log::set_max_level(log::LevelFilter::Info);
    std::panic::set_hook(Box::new(|info| {
        log(&format!("Panic: {:?}", info));
    }));
}

#[wasm_bindgen]
pub fn instrument_allocator(bytes: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    init_once();
    match instrumentor::instrument(bytes, &instrumentor::allocator_tracees()) {
        Ok(instrumented) => Ok(instrumented),
        Err(e) => Err(JsValue::from_str(&format!(
            "Failed to instrument WebAssembly module: {}",
            e
        ))),
    }
}
