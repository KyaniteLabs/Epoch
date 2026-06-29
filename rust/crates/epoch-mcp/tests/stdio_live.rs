use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn isolated_data_dir(label: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "epoch-mcp-stdio-live-{label}-{}-{unique}",
        std::process::id()
    ))
}

#[test]
fn line_delimited_stdio_responds_before_stdin_eof() {
    let data_dir = isolated_data_dir("line");
    let mut child = Command::new(env!("CARGO_BIN_EXE_epoch-mcp"))
        .env("EPOCH_DATA_DIR", &data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn epoch-mcp");

    let mut stdin = child.stdin.take().expect("child stdin");
    let stdout = child.stdout.take().expect("child stdout");
    let (tx, rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first_line = String::new();
        reader.read_line(&mut first_line).expect("read response");
        tx.send(first_line).expect("send response line");
    });

    stdin
        .write_all(br#"{ "jsonrpc": "2.0", "id": 1, "method": "ping" }"#)
        .expect("write request");
    stdin.write_all(b"\n").expect("write newline");
    stdin.flush().expect("flush request");

    let first_line = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("epoch-mcp responded before stdin EOF");
    assert!(first_line.starts_with("Content-Length:"));

    child.kill().expect("stop child");
    let _ = child.wait();
    let _ = reader.join();
    let _ = fs::remove_dir_all(data_dir);
}

#[test]
fn framed_stdio_responds_before_stdin_eof() {
    let data_dir = isolated_data_dir("framed");
    let mut child = Command::new(env!("CARGO_BIN_EXE_epoch-mcp"))
        .env("EPOCH_DATA_DIR", &data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn epoch-mcp");

    let mut stdin = child.stdin.take().expect("child stdin");
    let stdout = child.stdout.take().expect("child stdout");
    let (tx, rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first_line = String::new();
        reader.read_line(&mut first_line).expect("read response");
        tx.send(first_line).expect("send response line");
    });

    let body = br#"{ "jsonrpc": "2.0", "id": 2, "method": "ping" }"#;
    stdin
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .expect("write frame header");
    stdin.write_all(body).expect("write frame body");
    stdin.flush().expect("flush request");

    let first_line = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("epoch-mcp responded before stdin EOF");
    assert!(first_line.starts_with("Content-Length:"));

    child.kill().expect("stop child");
    let _ = child.wait();
    let _ = reader.join();
    let _ = fs::remove_dir_all(data_dir);
}
