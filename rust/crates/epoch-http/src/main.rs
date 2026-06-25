use epoch_http::{HttpMethod, RustHttpResponse, RustHttpRouter};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

fn main() {
    let address = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("EPOCH_HTTP_ADDR").ok())
        .unwrap_or_else(|| "127.0.0.1:8787".to_string());
    let listener = TcpListener::bind(&address).unwrap_or_else(|error| {
        eprintln!("failed to bind {address}: {error}");
        std::process::exit(1);
    });
    eprintln!("epoch-http listening on http://{address}");

    let router = Arc::new(Mutex::new(RustHttpRouter::new()));
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
        Ok((method, path, body)) => router
            .lock()
            .expect("router mutex not poisoned")
            .route(method, &path, body),
        Err(message) => RustHttpResponse {
            status: 400,
            body: json!({ "error": { "message": message } }),
        },
    };

    if let Err(error) = stream.write_all(format_response(response).as_bytes()) {
        eprintln!("failed to write response: {error}");
    }
}

fn parse_request(raw: &str) -> Result<(HttpMethod, String, Value), String> {
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
    let json_body = if body.trim().is_empty() {
        query_to_body(query)
    } else {
        serde_json::from_str(body.trim()).map_err(|error| format!("invalid JSON body: {error}"))?
    };

    Ok((method, path.to_string(), json_body))
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
    use super::{format_response, parse_request};
    use epoch_http::HttpMethod;
    use serde_json::json;

    #[test]
    fn parses_get_query_and_post_json() {
        let (method, path, body) =
            parse_request("GET /v1/feedback/pending?limit=3 HTTP/1.1\r\n\r\n").expect("GET parses");
        assert_eq!(method, HttpMethod::Get);
        assert_eq!(path, "/v1/feedback/pending");
        assert_eq!(body["limit"], 3);

        let (_, path, body) = parse_request(
            "POST /v1/tools/parse_duration HTTP/1.1\r\nContent-Length: 27\r\n\r\n{\"duration_string\":\"1h\"}",
        )
        .expect("POST parses");
        assert_eq!(path, "/v1/tools/parse_duration");
        assert_eq!(body["duration_string"], "1h");
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
}
