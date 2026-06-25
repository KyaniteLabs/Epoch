use epoch_cli::run_cli_json;
use epoch_mcp::RustToolDispatcher;
use serde_json::json;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        print_usage_and_exit();
    };
    let input = args.next().unwrap_or_else(|| "{}".to_string());
    let mut dispatcher = RustToolDispatcher::new();

    match run_cli_json(&mut dispatcher, &command, &input) {
        Ok(value) => println!(
            "{}",
            serde_json::to_string_pretty(&value).expect("JSON serialization succeeds")
        ),
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::to_string_pretty(&json!({ "error": error }))
                    .expect("JSON serialization succeeds")
            );
            std::process::exit(2);
        }
    }
}

fn print_usage_and_exit() -> ! {
    eprintln!("usage: epoch-cli <command-path> [json-input]");
    eprintln!(
        "example: epoch-cli pert-estimate '{{\"optimistic\":1,\"most_likely\":2,\"pessimistic\":4}}'"
    );
    std::process::exit(2);
}
