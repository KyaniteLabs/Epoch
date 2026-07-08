use epoch_mcp::{McpRuntime, RustToolDispatcher, process_message_reader};
use std::io::{self, BufReader, BufWriter};

fn main() {
    let dispatcher = RustToolDispatcher::persistent_from_env().unwrap_or_else(|error| {
        eprintln!("failed to initialize feedback store: {error}");
        std::process::exit(1);
    });
    let mut runtime = McpRuntime::with_dispatcher(dispatcher);
    let stdin = io::stdin();
    let stdout = io::stdout();
    if let Err(error) = process_message_reader(
        &mut runtime,
        BufReader::new(stdin.lock()),
        BufWriter::new(stdout.lock()),
    ) {
        eprintln!("failed to process MCP stdio stream: {error}");
        std::process::exit(1);
    }
}
