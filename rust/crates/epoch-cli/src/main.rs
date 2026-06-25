use epoch_cli::{cli_command_paths, run_cli_json};
use epoch_mcp::RustToolDispatcher;
use serde_json::json;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let Some((command, input)) = parse_invocation(args) else {
        print_usage_and_exit();
    };
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

fn parse_invocation(args: Vec<String>) -> Option<(String, String)> {
    if args.is_empty() {
        return None;
    }

    for split_at in (1..=args.len()).rev() {
        let command = args[..split_at].join(" ");
        if cli_command_paths().contains(&command.as_str()) {
            let input = if split_at < args.len() {
                args[split_at..].join(" ")
            } else {
                "{}".to_string()
            };
            return Some((command, input));
        }
    }

    let command = args[0].clone();
    let input = if args.len() > 1 {
        args[1..].join(" ")
    } else {
        "{}".to_string()
    };
    Some((command, input))
}

fn print_usage_and_exit() -> ! {
    eprintln!("usage: epoch-cli <command-path> [json-input]");
    eprintln!(
        "example: epoch-cli pert-estimate '{{\"optimistic\":1,\"most_likely\":2,\"pessimistic\":4}}'"
    );
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::parse_invocation;

    #[test]
    fn parses_one_word_commands_with_json() {
        let (command, input) = parse_invocation(vec![
            "pert-estimate".to_string(),
            r#"{"optimistic":1,"most_likely":2,"pessimistic":4}"#.to_string(),
        ])
        .expect("invocation parses");

        assert_eq!(command, "pert-estimate");
        assert_eq!(input, r#"{"optimistic":1,"most_likely":2,"pessimistic":4}"#);
    }

    #[test]
    fn parses_multi_word_commands_without_json() {
        let (command, input) =
            parse_invocation(vec!["telemetry".to_string(), "status".to_string()])
                .expect("invocation parses");

        assert_eq!(command, "telemetry status");
        assert_eq!(input, "{}");
    }

    #[test]
    fn parses_multi_word_commands_with_json() {
        let (command, input) = parse_invocation(vec![
            "telemetry".to_string(),
            "set-endpoint".to_string(),
            r#"{"endpoint":"http://127.0.0.1:8787"}"#.to_string(),
        ])
        .expect("invocation parses");

        assert_eq!(command, "telemetry set-endpoint");
        assert_eq!(input, r#"{"endpoint":"http://127.0.0.1:8787"}"#);
    }
}
