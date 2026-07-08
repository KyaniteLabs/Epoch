use epoch_http::{HttpMethod, RustHttpResponse, RustHttpRouter};
use epoch_mcp::RustToolDispatcher;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

fn main() {
    let arg = std::env::args().nth(1);
    if arg.as_deref().is_some_and(is_help_arg) {
        print_usage();
        return;
    }

    let address = resolve_address(arg.as_deref(), |name| std::env::var(name).ok());
    let listener = TcpListener::bind(&address).unwrap_or_else(|error| {
        eprintln!("failed to bind {address}: {error}");
        std::process::exit(1);
    });
    eprintln!("epoch-http listening on http://{address}");

    let dispatcher = RustToolDispatcher::persistent_from_env().unwrap_or_else(|error| {
        eprintln!("failed to initialize feedback store: {error}");
        std::process::exit(1);
    });
    let router = Arc::new(Mutex::new(RustHttpRouter::with_dispatcher(dispatcher)));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let router = Arc::clone(&router);
                thread::spawn(move || handle_connection(stream, router));
            }
            Err(error) => eprintln!("connection failed: {error}"),
        }
    }
}

fn print_usage() {
    println!(
        "Usage: epoch-http [HOST:PORT]\n\
         \n\
         Environment:\n\
           EPOCH_HTTP_ADDR  Full listen address, for example 127.0.0.1:8787\n\
           EPOCH_HOST       Listen host when EPOCH_HTTP_ADDR is not set (default: 127.0.0.1)\n\
           EPOCH_PORT       Listen port when EPOCH_HTTP_ADDR is not set (default: 3000)\n\
           PORT             Fallback listen port when EPOCH_PORT is not set"
    );
}

fn is_help_arg(arg: &str) -> bool {
    matches!(arg, "-h" | "--help")
}

fn resolve_address<F>(arg: Option<&str>, get_env: F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    if let Some(address) = arg.and_then(non_empty) {
        return address.to_string();
    }
    if let Some(address) = env_value(&get_env, "EPOCH_HTTP_ADDR") {
        return address;
    }

    let host = env_value(&get_env, "EPOCH_HOST").unwrap_or_else(|| "127.0.0.1".to_string());
    let port = env_value(&get_env, "EPOCH_PORT")
        .or_else(|| env_value(&get_env, "PORT"))
        .unwrap_or_else(|| "3000".to_string());
    format!("{host}:{port}")
}

fn env_value<F>(get_env: &F, name: &str) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    get_env(name).and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn handle_connection(mut stream: TcpStream, router: Arc<Mutex<RustHttpRouter>>) {
    let mut buffer = vec![0_u8; 65_536];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(bytes_read) => bytes_read,
        Err(error) => {
            eprintln!("failed to read request: {error}");
            return;
        }
    };
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let response = match parse_request(&request) {
        Ok(request) => router
            .lock()
            .expect("router mutex not poisoned")
            .route_with_headers(
                request.method,
                &request.path,
                request.body,
                Some(&request.raw_body),
                &request.headers,
            ),
        Err(message) => RustHttpResponse {
            status: 400,
            body: json!({
                "ok": false,
                "error": {
                    "isError": true,
                    "message": message,
                    "retryHint": "Send a valid HTTP request with a JSON body.",
                },
            }),
        },
    };

    if let Err(error) = stream.write_all(format_response(response).as_bytes()) {
        eprintln!("failed to write response: {error}");
    }
}

#[derive(Debug, Clone)]
struct ParsedRequest {
    method: HttpMethod,
    path: String,
    body: Value,
    raw_body: String,
    headers: BTreeMap<String, String>,
}

fn parse_request(raw: &str) -> Result<ParsedRequest, String> {
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .or_else(|| raw.split_once("\n\n"))
        .unwrap_or((raw, ""));
    let mut lines = head.lines();
    let request_line = lines.next().ok_or("missing request line")?;
    let mut parts = request_line.split_whitespace();
    let method = match parts.next().ok_or("missing method")? {
        "GET" => HttpMethod::Get,
        "POST" => HttpMethod::Post,
        other => return Err(format!("unsupported method: {other}")),
    };
    let raw_path = parts.next().ok_or("missing path")?;
    let (path, query) = raw_path.split_once('?').unwrap_or((raw_path, ""));
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect::<BTreeMap<_, _>>();
    let raw_body = body.to_string();
    let json_body = if raw_body.trim().is_empty() {
        query_to_body(query)
    } else {
        serde_json::from_str(raw_body.trim())
            .map_err(|error| format!("invalid JSON body: {error}"))?
    };

    Ok(ParsedRequest {
        method,
        path: path.to_string(),
        body: json_body,
        raw_body,
        headers,
    })
}

fn query_to_body(query: &str) -> Value {
    let mut object = serde_json::Map::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        object.insert(key.to_string(), parse_query_value(value));
    }
    Value::Object(object)
}

fn parse_query_value(value: &str) -> Value {
    value
        .parse::<i64>()
        .map(Value::from)
        .unwrap_or_else(|_| Value::String(value.replace('+', " ")))
}

fn format_response(response: RustHttpResponse) -> String {
    let content_type = if response.body.is_string() {
        "text/plain; charset=utf-8"
    } else {
        "application/json; charset=utf-8"
    };
    let body = response
        .body
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| response.body.to_string());
    let reason = match response.status {
        200 => "OK",
        202 => "Accepted",
        401 => "Unauthorized",
        400 => "Bad Request",
        404 => "Not Found",
        422 => "Unprocessable Entity",
        _ => "OK",
    };

    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response.status,
        reason,
        content_type,
        body.len(),
        body
    )
}

#[cfg(test)]
mod tests {
    use super::{format_response, is_help_arg, parse_request, resolve_address};
    use epoch_http::HttpMethod;
    use serde_json::json;
    use std::collections::HashMap;

    fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map = vars
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect::<HashMap<_, _>>();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn parses_get_query_and_post_json() {
        let request =
            parse_request("GET /v1/feedback/pending?limit=3 HTTP/1.1\r\n\r\n").expect("GET parses");
        assert_eq!(request.method, HttpMethod::Get);
        assert_eq!(request.path, "/v1/feedback/pending");
        assert_eq!(request.body["limit"], 3);

        let request = parse_request(
            "POST /v1/tools/parse_duration HTTP/1.1\r\nContent-Length: 27\r\nX-Epoch-Signature: abc\r\n\r\n{\"duration_string\":\"1h\"}",
        )
        .expect("POST parses");
        assert_eq!(request.path, "/v1/tools/parse_duration");
        assert_eq!(request.body["duration_string"], "1h");
        assert_eq!(request.raw_body, "{\"duration_string\":\"1h\"}");
        assert_eq!(
            request.headers.get("x-epoch-signature").map(String::as_str),
            Some("abc")
        );
    }

    #[test]
    fn formats_json_response() {
        let response = format_response(epoch_http::RustHttpResponse {
            status: 200,
            body: json!({ "ok": true }),
        });

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("application/json"));
        assert!(response.ends_with("{\"ok\":true}"));
    }

    #[test]
    fn resolves_typescript_compatible_http_address() {
        assert_eq!(resolve_address(None, env(&[])), "127.0.0.1:3000");
        assert_eq!(
            resolve_address(
                None,
                env(&[("EPOCH_HOST", "0.0.0.0"), ("EPOCH_PORT", "3099")])
            ),
            "0.0.0.0:3099"
        );
        assert_eq!(
            resolve_address(None, env(&[("PORT", "4000")])),
            "127.0.0.1:4000"
        );
        assert_eq!(
            resolve_address(None, env(&[("EPOCH_PORT", "3099"), ("PORT", "4000")])),
            "127.0.0.1:3099"
        );
    }

    #[test]
    fn resolves_explicit_http_address_first() {
        assert_eq!(
            resolve_address(
                Some("127.0.0.1:5050"),
                env(&[("EPOCH_HTTP_ADDR", "0.0.0.0:8080")])
            ),
            "127.0.0.1:5050"
        );
        assert_eq!(
            resolve_address(
                None,
                env(&[
                    ("EPOCH_HTTP_ADDR", "0.0.0.0:8787"),
                    ("EPOCH_HOST", "127.0.0.1"),
                    ("EPOCH_PORT", "3000")
                ])
            ),
            "0.0.0.0:8787"
        );
    }

    #[test]
    fn recognizes_help_args() {
        assert!(is_help_arg("--help"));
        assert!(is_help_arg("-h"));
        assert!(!is_help_arg("127.0.0.1:3000"));
    }
}
