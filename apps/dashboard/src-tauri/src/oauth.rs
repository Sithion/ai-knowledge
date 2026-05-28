//! Loopback redirect helper for the interactive OAuth 2.1 (PKCE) flow with remote
//! MCP servers. RFC 8252: a native app binds a loopback port, sends the browser to
//! the authorization URL, and captures the `?code=…` redirect on that port.
//!
//! Two-step so the redirect_uri is known before the sidecar (which owns the MCP
//! OAuth client) builds the authorization URL:
//!   1. `oauth_reserve()`        → bind 127.0.0.1:0, return { port, redirect_uri }
//!   2. `oauth_await(port, url)` → open the browser at `url`, await one /callback hit

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, State};

/// Listeners reserved by `oauth_reserve`, consumed by `oauth_await`, keyed by port.
pub struct OAuthListeners(pub Mutex<HashMap<u16, TcpListener>>);
impl Default for OAuthListeners {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

#[derive(serde::Serialize)]
pub struct ReserveResult {
    pub port: u16,
    pub redirect_uri: String,
}

#[tauri::command]
pub fn oauth_reserve(state: State<OAuthListeners>) -> Result<ReserveResult, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    state.0.lock().map_err(|e| e.to_string())?.insert(port, listener);
    Ok(ReserveResult { port, redirect_uri: format!("http://127.0.0.1:{}/callback", port) })
}

#[derive(serde::Serialize)]
pub struct CallbackResult {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Open the browser at `authorize_url` and block until the reserved loopback port
/// receives the OAuth redirect (or a 120s timeout). Returns code/state/error.
#[tauri::command]
pub async fn oauth_await(app: tauri::AppHandle, port: u16, authorize_url: String) -> Result<CallbackResult, String> {
    let listeners = app.state::<OAuthListeners>();
    let listener = {
        let mut map = listeners.0.lock().map_err(|e| e.to_string())?;
        map.remove(&port).ok_or_else(|| format!("no reserved OAuth listener for port {}", port))?
    };

    if let Err(e) = open::that(&authorize_url) {
        return Err(format!("failed to open browser: {}", e));
    }

    let res = tokio::task::spawn_blocking(move || wait_for_callback(listener))
        .await
        .map_err(|e| e.to_string())??;
    Ok(res)
}

fn wait_for_callback(listener: TcpListener) -> Result<CallbackResult, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if Instant::now() > deadline {
            return Err("timed out waiting for the OAuth callback".to_string());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                // Browsers often open a second TCP connection immediately after the
                // redirect (favicon fetch, HTTP/1.1 pipelining probe) that carries 0
                // bytes or an unrelated path (e.g. GET /favicon.ico). Skip these —
                // they carry no authorization code — and keep waiting for the real
                // redirect on the next accept() iteration.
                if n == 0 {
                    continue;
                }
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("");
                let parsed = parse_callback(path);
                if parsed.code.is_none() && parsed.error.is_none() {
                    // Not the real callback (no code, no error) — keep waiting.
                    continue;
                }
                let body = "<!doctype html><meta charset=utf-8><body style=\"font-family:-apple-system,sans-serif;background:#0d0d1a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh\"><div style=\"text-align:center\"><div style=\"font-size:42px\">🧠</div><h2>CogniStore connected</h2><p>You can close this tab and return to the app.</p></div></body>";
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(), body
                    ).as_bytes(),
                );
                let _ = stream.flush();
                return Ok(parsed);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn parse_callback(path: &str) -> CallbackResult {
    let query = path.splitn(2, '?').nth(1).unwrap_or("");
    let mut out = CallbackResult { code: None, state: None, error: None };
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        let key = kv.next().unwrap_or("");
        let val = urldecode(kv.next().unwrap_or(""));
        match key {
            "code" => out.code = Some(val),
            "state" => out.state = Some(val),
            "error" => out.error = Some(val),
            _ => {}
        }
    }
    out
}

/// Minimal percent-decoding (`+` → space) for query-string values.
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(b);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
