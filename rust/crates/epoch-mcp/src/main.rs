use epoch_mcp::{McpRuntime, RustToolDispatcher, process_message_stream};
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        eprintln!("failed to read stdin: {error}");
        std::process::exit(1);
    }

    let dispatcher = RustToolDispatcher::persistent_from_env().unwrap_or_else(|error| {
        eprintln!("failed to initialize feedback store: {error}");
        std::process::exit(1);
    });
    let mut runtime = McpRuntime::with_dispatcher(dispatcher);
    print!("{}", process_message_stream(&mut runtime, &input));
}
