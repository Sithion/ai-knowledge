use std::env;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

/// The nvm installer we bootstrap Node with, pinned by tag AND by content hash.
/// Recompute with: curl -fsSL <url> | shasum -a 256
const NVM_INSTALL_URL: &str = "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh";
const NVM_INSTALL_SHA256: &str = "2d8359a64a3cb07c02389ad88ceecd43f2fa469c06104f92f98df5b6f315275f";

pub struct SidecarState {
    child: Mutex<Option<Child>>,
}

impl SidecarState {
    pub fn new(child: Child) -> Self {
        Self {
            child: Mutex::new(Some(child)),
        }
    }

    pub fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// The Node.js major version that native modules (better-sqlite3) are compiled against.
/// Pinned exactly: better-sqlite3 is a V8-ABI addon (not N-API), so the runtime major
/// must match the bundled binary's NODE_MODULE_VERSION (Node 24 = 137).
const REQUIRED_NODE_MAJOR: u32 = 24;

/// Find the Node.js binary on the system, preferring the version that matches
/// the native modules compiled in the sidecar bundle.
pub fn find_node() -> Result<PathBuf, String> {
    // 1. Check nvm for the required major version first (most reliable)
    if let Some(home) = dirs::home_dir() {
        let nvm_dir = home.join(".nvm").join("versions").join("node");
        if nvm_dir.exists() {
            if let Ok(node) = find_nvm_node(&nvm_dir, REQUIRED_NODE_MAJOR) {
                return Ok(node);
            }
        }
    }

    // 2. Check if system node matches the required version
    if let Ok(output) = Command::new("which").arg("node").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                let p = PathBuf::from(&path);
                if check_node_major(&p, REQUIRED_NODE_MAJOR) {
                    return Ok(p);
                }
            }
        }
    }

    // 3. Fallback paths — only if version matches
    let fallbacks = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];

    for path in &fallbacks {
        let p = PathBuf::from(path);
        if p.exists() && check_node_major(&p, REQUIRED_NODE_MAJOR) {
            return Ok(p);
        }
    }

    // 4. Auto-install: nvm + Node.js (required major)
    eprintln!("Node.js v{} not found — installing via nvm...", REQUIRED_NODE_MAJOR);
    install_node_via_nvm(REQUIRED_NODE_MAJOR)
}

/// Find a Node.js binary in nvm matching the required major version.
fn find_nvm_node(nvm_dir: &PathBuf, major: u32) -> Result<PathBuf, String> {
    let prefix = format!("v{}.", major);
    let mut matches: Vec<PathBuf> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(nvm_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                let node_bin = entry.path().join("bin").join("node");
                if node_bin.exists() {
                    matches.push(node_bin);
                }
            }
        }
    }

    matches.sort();
    matches.last().cloned().ok_or_else(|| format!("No Node.js v{} found in nvm", major))
}

/// Install nvm (if missing) and Node.js via nvm, returning the path to the node binary.
fn install_node_via_nvm(major: u32) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let nvm_dir = home.join(".nvm");
    let nvm_sh = nvm_dir.join("nvm.sh");

    // Install nvm if not present
    if !nvm_sh.exists() {
        eprintln!("Installing nvm...");
        // Download, VERIFY, then run — rather than piping the network straight
        // into bash. The URL is tag-pinned, but a tag can be moved and TLS alone
        // does not tell us the bytes are the ones we reviewed. This is the same
        // treatment ci.yml already gives the OSV-Scanner binary.
        //
        // A stable target makes a content hash safe here; contrast
        // ollama.com/install.sh, a ROLLING url where pinning a hash would break
        // setup on every upstream release.
        let status = Command::new("bash")
            .arg("-c")
            .arg(format!(
                r#"set -euo pipefail
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL {url} -o "$tmp/install.sh"
echo "{sha}  $tmp/install.sh" | shasum -a 256 -c - >/dev/null 2>&1 || \
  echo "{sha}  $tmp/install.sh" | sha256sum -c - >/dev/null
NVM_DIR="{dir}" bash "$tmp/install.sh""#,
                url = NVM_INSTALL_URL,
                sha = NVM_INSTALL_SHA256,
                dir = nvm_dir.display()
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .status()
            .map_err(|e| format!("Failed to run nvm installer: {}", e))?;

        if !status.success() {
            return Err(
                "nvm installation failed (the installer download may have failed its checksum check)"
                    .to_string(),
            );
        }

        if !nvm_sh.exists() {
            return Err("nvm installed but nvm.sh not found".to_string());
        }
    }

    // Install Node.js via nvm
    eprintln!("Installing Node.js v{} via nvm...", major);
    let install_cmd = format!(
        "export NVM_DIR=\"{}\" && . \"$NVM_DIR/nvm.sh\" && nvm install {}",
        nvm_dir.display(),
        major
    );
    let output = Command::new("bash")
        .arg("-c")
        .arg(&install_cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run nvm install: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("nvm install failed: {}", stderr));
    }

    // Find the installed binary
    let node_dir = nvm_dir.join("versions").join("node");
    find_nvm_node(&node_dir, major)
        .map_err(|_| format!("Node.js v{} was installed but binary not found", major))
}

/// Check if a Node.js binary is the required major version.
fn check_node_major(node_bin: &PathBuf, major: u32) -> bool {
    if let Ok(output) = Command::new(node_bin).arg("--version").output() {
        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(stripped) = version.strip_prefix('v') {
                if let Some(major_str) = stripped.split('.').next() {
                    if let Ok(v) = major_str.parse::<u32>() {
                        return v == major;
                    }
                }
            }
        }
    }
    false
}

/// Generate a cryptographically-random 16-byte sidecar identity token.
fn generate_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("getrandom failed");
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Spawn the Fastify server as a child process.
///
/// Returns the child, the sidecar identity token, and the child's stdout — the
/// last of which is taken here rather than left on the Child because readiness
/// is signalled over it (see `wait_for_ready`) and the Child itself is handed to
/// `SidecarState` for lifecycle management.
pub fn spawn_node(
    node_bin: &PathBuf,
    script_path: &PathBuf,
    resource_dir: &PathBuf,
    sqlite_path: &PathBuf,
    port: u16,
) -> Result<(Child, String, std::process::ChildStdout), String> {
    let dist_path = resource_dir.join("dist");
    let node_modules_path = resource_dir.join("node_modules");
    let templates_path = resource_dir.join("templates");
    let token = generate_token();

    let mut cmd = Command::new(node_bin);
    cmd.arg(script_path)
        .env("SQLITE_PATH", sqlite_path.to_string_lossy().to_string())
        .env("OLLAMA_HOST", "http://localhost:11434")
        .env("OLLAMA_MODEL", env::var("OLLAMA_MODEL").unwrap_or_else(|_| "nomic-embed-text".into()))
        .env("EMBEDDING_DIMENSIONS", "256")
        .env("DASHBOARD_PORT", port.to_string())
        .env("DASHBOARD_DIST_PATH", dist_path.to_string_lossy().to_string())
        .env("TEMPLATES_PATH", templates_path.to_string_lossy().to_string())
        .env("NODE_ENV", "production")
        .env("NODE_PATH", node_modules_path.to_string_lossy().to_string())
        // Marks a sidecar owned by the desktop app, so it may re-deploy the user's
        // agent configs on a version change. Tests spawn the same server binary
        // (with SIDECAR_TOKEN and NODE_ENV set) against a real HOME, so this is the
        // only reliable discriminator.
        .env("COGNISTORE_MANAGED", "1")
        .env("SIDECAR_TOKEN", &token);

    // Inject external-provider secrets from the OS keychain (Rust is the only
    // keychain-touching process). The sidecar forwards these to the MCP subprocess
    // via buildMcpEntry, and the SDK's EnvSecretStore reads them.
    if let Some(dir) = sqlite_path.parent() {
        let providers_json = dir.join("providers.json");
        for id in crate::secrets::provider_ids_from_config(&providers_json) {
            if let Some(secret) = crate::secrets::read_provider_secret(&id) {
                cmd.env(crate::secrets::sanitize_env_key(&id), secret);
            }
        }
    }

    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start server: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture server stdout".to_string())?;

    // Drain stderr for the life of the process. Never taking this handle left
    // it attached but unread — harmless until the OS pipe buffer (64KB) fills,
    // at which point the sidecar's next stderr write blocks. Logging it here
    // also means a future crash surfaces in the app log instead of vanishing.
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[sidecar stderr] {}", line);
            }
        });
    }

    Ok((child, token, stdout))
}

/// The line the sidecar prints on stdout once it is listening.
/// Must stay identical to READY_MARKER in apps/dashboard/server/index.ts.
pub const READY_MARKER: &str = "COGNISTORE_SIDECAR_READY";

/// Wait for the sidecar to report readiness on ITS OWN stdout pipe.
///
/// This used to be an HTTP poll of /api/health that accepted the sidecar as ours
/// only if the response body echoed the identity token. That worked as an
/// anti-squatting check, but it required the token to be readable from an
/// unauthenticated endpoint — so any page served by any other local HTTP server
/// could simply fetch it and then drive the whole API.
///
/// The stdout pipe is a strictly better proof of identity: only the process we
/// spawned can write to it, so nothing on the network can forge readiness, and
/// no secret has to be published to establish it. It is also edge-triggered
/// rather than polled, so the window opens as soon as the server binds.
///
/// CRITICAL: this must never let the `ChildStdout` be dropped once the marker
/// is found. Dropping it closes the pipe's read end, and the sidecar's very
/// next `console.log` (its access logger fires on nearly every request) then
/// hits EPIPE and crashes uncaught — Node does not install a SIGPIPE handler
/// for piped (non-TTY) stdio, so the write failure surfaces as an unhandled
/// 'error' event, which is fatal. Reproduced directly: read the marker line
/// via a pipe, close the read end the way the old code did on return, and the
/// spawned Node process dies on its next stdout write with `Error: write
/// EPIPE`. The fix is to keep draining (and discarding) stdout for the life
/// of the process instead of returning ownership of the reader to be dropped.
pub async fn wait_for_ready(stdout: std::process::ChildStdout, timeout: Duration) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

    // Detached — intentionally NOT joined by this function, so the pipe stays
    // drained for as long as the child writes to it, well past the timeout
    // window below.
    tokio::task::spawn_blocking(move || {
        let reader = BufReader::new(stdout);
        let mut tx = Some(tx);
        for line in reader.lines() {
            match line {
                Ok(l) if l.contains(READY_MARKER) => {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(true);
                    }
                    // Keep looping — do NOT return/break — so `reader` (and the
                    // ChildStdout it owns) is never dropped while the child is
                    // still alive.
                }
                Ok(_) => continue,
                // EOF or a decode error means the child died or closed stdout.
                Err(_) => break,
            }
        }
        // Reached EOF without ever finding the marker (or a read error) —
        // the child exited before becoming ready.
        if let Some(tx) = tx.take() {
            let _ = tx.send(false);
        }
    });

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(ready)) => ready,
        _ => false,
    }
}

/// Find an available port in a FIXED range, probing 127.0.0.1 — the address the
/// Fastify server actually binds (the comment here used to claim 0.0.0.0, which
/// would be a world-reachable bind and is exactly the regression not to invite).
///
/// There is deliberately no OS-assigned-port fallback. The sidecar's Origin and
/// Host checks, and the Tauri capability's `remote.urls`, are all pinned to this
/// range; a port outside it would be reachable but unprotected by them. Having
/// all 100 ports occupied is pathological, and failing with a clear error beats
/// silently opening on an origin nothing trusts.
pub fn find_available_port(preferred: u16) -> Option<u16> {
    (preferred..preferred + 100)
        .find(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
}
