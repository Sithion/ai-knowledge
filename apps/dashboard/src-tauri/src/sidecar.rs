use std::env;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
const REQUIRED_NODE_MAJOR: u32 = 20;

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

    // 4. Auto-install: nvm + Node.js v20
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
        let status = Command::new("bash")
            .arg("-c")
            .arg(format!(
                "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | NVM_DIR=\"{}\" bash",
                nvm_dir.display()
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .status()
            .map_err(|e| format!("Failed to run nvm installer: {}", e))?;

        if !status.success() {
            return Err("nvm installation failed".to_string());
        }

        if !nvm_sh.exists() {
            return Err("nvm installed but nvm.sh not found".to_string());
        }
    }

    // Install Node.js via nvm
    eprintln!("Installing Node.js v{} via nvm...", major);
    let install_cmd = format!(
        "export NVM_DIR=\"{}\" && . \"$NVM_DIR/nvm.sh\" && nvm install {} --lts",
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
/// Returns the child process and the sidecar identity token.
pub fn spawn_node(
    node_bin: &PathBuf,
    script_path: &PathBuf,
    resource_dir: &PathBuf,
    sqlite_path: &PathBuf,
    port: u16,
) -> Result<(Child, String), String> {
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

    let child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start server: {}", e))?;

    Ok((child, token))
}

/// Wait for the Fastify server to respond on /api/health with the correct sidecar token.
/// Uses a raw HTTP request over TCP to avoid adding a reqwest dependency.
pub async fn wait_for_ready(port: u16, token: &str, timeout: Duration) -> bool {
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if let Ok(mut stream) =
            tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port)).await
        {
            let req = format!(
                "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                port
            );
            if stream.write_all(req.as_bytes()).await.is_ok() {
                let mut buf = vec![0u8; 4096];
                if let Ok(n) = stream.read(&mut buf).await {
                    let response = String::from_utf8_lossy(&buf[..n]);
                    // Verify the response contains our sidecar token
                    if response.contains("200 OK")
                        && response.contains(&format!("\"token\":\"{}\"", token))
                    {
                        return true;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    false
}

/// Find an available port, starting from the preferred one.
/// Binds on 0.0.0.0 to match the Fastify server's listen address.
pub fn find_available_port(preferred: u16) -> u16 {
    for port in preferred..preferred + 100 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    // Fallback: let OS assign
    if let Ok(listener) = std::net::TcpListener::bind("127.0.0.1:0") {
        if let Ok(addr) = listener.local_addr() {
            return addr.port();
        }
    }
    preferred
}
