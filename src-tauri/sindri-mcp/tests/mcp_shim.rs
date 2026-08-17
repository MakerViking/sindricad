//! The MCP shim, driven the way a client drives it: real process, real stdio,
//! real socket.
//!
//! Worth doing as an integration test rather than unit tests over `handle()`:
//! every bug this catches is a PROTOCOL bug, and protocol bugs live in the
//! wiring — a notification that gets answered, a tool error raised as a
//! JSON-RPC error, a stray byte on stdout. None of those are visible from
//! inside a function.
//!
//! The broker is faked here on purpose. What is under test is the shim's half
//! of the conversation; `agent_ipc.rs` has its own tests, and the real thing
//! needs a running app.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;

use serde_json::{json, Value};

const TOKEN: &str = "t0ken";

/// A broker that answers one request per connection, and reports what it saw.
fn fake_broker(dir: &std::path::Path) -> (std::path::PathBuf, mpsc::Receiver<Value>) {
    let sock = dir.join("sock");
    let handshake = dir.join("handshake.json");
    std::fs::write(
        &handshake,
        json!({ "version": 1, "socket": sock.to_string_lossy(), "token": TOKEN }).to_string(),
    )
    .unwrap();

    let listener = UnixListener::bind(&sock).unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(stream) = conn else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                continue;
            }
            let req: Value = serde_json::from_str(&line).unwrap();
            let _ = tx.send(req.clone());

            let reply = if req["token"] != TOKEN {
                json!({ "id": req["id"], "ok": false,
                        "error": { "code": "unauthorized", "message": "bad token" } })
            } else if req["tool"] == "doc.read" {
                json!({ "id": req["id"], "ok": true,
                        "result": { "bodies": [{ "id": "body1",
                                                 "name": "⟦untrusted:name⟧Bracket⟦/untrusted⟧" }] } })
            } else {
                json!({ "id": req["id"], "ok": false,
                        "error": { "code": "measureFailed", "message": "nope" } })
            };
            let mut w = &stream;
            let _ = writeln!(w, "{reply}");
            let _ = w.flush();
        }
    });
    (handshake, rx)
}

struct Shim {
    child: Child,
    out: BufReader<std::process::ChildStdout>,
}

impl Shim {
    fn spawn(handshake: Option<&std::path::Path>) -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_sindri-mcp"));
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        match handshake {
            Some(p) => cmd.env("SINDRI_AGENT_HANDSHAKE", p),
            // A path that cannot exist, to model "the app is not running".
            None => cmd.env("SINDRI_AGENT_HANDSHAKE", "/nonexistent/sindri/handshake.json"),
        };
        let mut child = cmd.spawn().expect("shim binary should be built");
        let out = BufReader::new(child.stdout.take().unwrap());
        Shim { child, out }
    }

    fn send(&mut self, v: Value) {
        let stdin = self.child.stdin.as_mut().unwrap();
        writeln!(stdin, "{v}").unwrap();
        stdin.flush().unwrap();
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        self.out.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("not JSON: {e}\nline was: {line}"))
    }
}

impl Drop for Shim {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("sindri-mcp-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn it_starts_and_lists_its_tools_even_with_no_app_running() {
    // The client launches its MCP servers at startup, long before the user opens
    // SindriCAD. Refusing to start would present as "the MCP server is broken"
    // when the truth is "the app is not open".
    let mut shim = Shim::spawn(None);

    shim.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }));
    let init = shim.recv();
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    let instructions = init["result"]["instructions"].as_str().unwrap();
    // The one warning that decides whether an agent fails loudly or silently.
    assert!(instructions.to_lowercase().contains("invented"), "{instructions}");
    assert!(instructions.contains("Read-only"));

    // A NOTIFICATION (no id) must not be answered. If it is, every subsequent
    // reply is off by one and the client desynchronises — so the assertion that
    // catches it is the id of the NEXT response.
    shim.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    shim.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    let list = shim.recv();
    assert_eq!(list["id"], 2, "a notification was answered: {list}");

    let tools = list["result"]["tools"].as_array().unwrap();
    let mut names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["build_status", "doc_read", "geom_measure", "geom_query", "sindri_schema"]);

    // ...and calling one says WHY it cannot work, rather than failing blankly.
    shim.send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                      "params": { "name": "doc_read", "arguments": {} } }));
    let call = shim.recv();
    assert_eq!(call["result"]["isError"], true);
    let text = call["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("does not appear to be running"), "{text}");
}

#[test]
fn it_forwards_a_tool_call_to_the_broker_and_returns_the_answer() {
    let dir = tmpdir("forward");
    let (handshake, seen) = fake_broker(&dir);
    let mut shim = Shim::spawn(Some(&handshake));

    shim.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": { "name": "doc_read", "arguments": {} } }));
    let reply = shim.recv();

    let req = seen.recv_timeout(std::time::Duration::from_secs(5)).expect("broker saw no request");
    // MCP tool names are underscored; the bridge speaks dots. The mapping is the
    // shim's job and this is the only place it is checked.
    assert_eq!(req["tool"], "doc.read");
    assert_eq!(req["token"], TOKEN);

    assert_eq!(reply["result"]["isError"], false);
    let text = reply["result"]["content"][0]["text"].as_str().unwrap();
    // The untrusted marker must reach the model INTACT. If the shim ever
    // re-serialises or unwraps it, the agent loses the only signal telling it
    // this text came from the file rather than from SindriCAD.
    assert!(text.contains("⟦untrusted:name⟧Bracket⟦/untrusted⟧"), "{text}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_tool_failure_is_not_a_protocol_failure() {
    // The distinction matters: a JSON-RPC error is the CLIENT's problem and is
    // usually not shown to the model, while `isError` on a successful response
    // is content the model reads and can act on. A geometry op that failed is
    // the second kind.
    let dir = tmpdir("errors");
    let (handshake, _seen) = fake_broker(&dir);
    let mut shim = Shim::spawn(Some(&handshake));

    shim.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": { "name": "geom_measure", "arguments": {} } }));
    let failed = shim.recv();
    assert!(failed.get("error").is_none(), "a tool failure must not be a JSON-RPC error: {failed}");
    assert_eq!(failed["result"]["isError"], true);
    assert!(failed["result"]["content"][0]["text"].as_str().unwrap().contains("measureFailed"));

    // An unknown METHOD, by contrast, genuinely is a protocol error.
    shim.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "nope/nope" }));
    let unknown = shim.recv();
    assert_eq!(unknown["error"]["code"], -32601);

    // An unknown TOOL is an invalid-params error: the method was fine.
    shim.send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                      "params": { "name": "doc_patch", "arguments": {} } }));
    let bad_tool = shim.recv();
    assert_eq!(bad_tool["error"]["code"], -32602, "{bad_tool}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn garbage_on_stdin_does_not_desynchronise_the_stream() {
    // A client that writes a stray blank line, or a log line that escapes into
    // the pipe, must not cost the next real request its answer.
    let mut shim = Shim::spawn(None);
    shim.send(json!("not an object"));
    let stdin = shim.child.stdin.as_mut().unwrap();
    writeln!(stdin, "").unwrap();
    writeln!(stdin, "{{ this is not json").unwrap();
    stdin.flush().unwrap();

    shim.send(json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" }));
    let pong = shim.recv();
    assert_eq!(pong["id"], 7, "the stream desynchronised: {pong}");
    assert!(pong["result"].is_object());
}
