use epoch_mcp::{McpRuntime, process_message_stream};
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        eprintln!("failed to read stdin: {error}");
        std::process::exit(1);
    }

    let mut runtime = McpRuntime::new();
    print!("{}", process_message_stream(&mut runtime, &input));
}
