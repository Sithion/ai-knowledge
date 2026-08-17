//! OS-keychain storage for external-provider credentials.
//!
//! The Tauri (Rust) process is the ONLY one that touches the keychain. Secrets are
//! injected into the Node sidecar (and onward to the MCP subprocess) as env vars
//! `COGNISTORE_PROVIDER_SECRET__<ID>`, which the SDK's EnvSecretStore reads. The
//! sanitization here MUST match `secretRefToEnvKey` in @cognistore/providers.

use tauri::Manager;
use serde_json::Value;
use std::fs;
use std::path::Path;

const SERVICE: &str = "cognistore";
/// Keychain service for OAuth sessions (tokens/clientInfo/verifier as a JSON blob, keyed by provider id).
const OAUTH_SERVICE: &str = "cognistore-oauth";

/// `company-wiki` -> `COGNISTORE_PROVIDER_SECRET__COMPANY_WIKI` (matches the TS side).
pub fn sanitize_env_key(id: &str) -> String {
    let up: String = id
        .to_uppercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("COGNISTORE_PROVIDER_SECRET__{}", up)
}

/// Read a provider's secret from the keychain (None if absent).
pub fn read_provider_secret(id: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, id).ok()?.get_password().ok()
}

/// Provider ids declared in providers.json (best-effort; [] on any error).
pub fn provider_ids_from_config(providers_json: &Path) -> Vec<String> {
    let txt = match fs::read_to_string(providers_json) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let val: Value = match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    val.get("providers")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.get("id").and_then(|i| i.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Require the caller to present the sidecar token before any keychain access.
///
/// The webview runs on `http://localhost:PORT`, not the asset protocol, so the
/// capability that lets it use IPC is a `remote` one — pinned to 3210-3309, but
/// that is still a RANGE, and any page loaded from an origin in it (a nested
/// frame, a redirect) would otherwise inherit the right to read the OS keychain.
/// The token is delivered to our own webview out of band via an initialization
/// script, so only code we seeded can produce it.
fn require_token(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    let expected = &app.state::<crate::widgets::TokenState>().token;
    // Length check first, then a constant-time-ish compare.
    if expected.is_empty() || token.len() != expected.len() {
        return Err("unauthorized".to_string());
    }
    let diff = token
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if diff != 0 {
        return Err("unauthorized".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn set_provider_secret(app: tauri::AppHandle, token: String, id: String, value: String) -> Result<(), String> {
    require_token(&app, &token)?;
    keyring::Entry::new(SERVICE, &id)
        .map_err(|e| e.to_string())?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_provider_secret(app: tauri::AppHandle, token: String, id: String) -> Result<(), String> {
    require_token(&app, &token)?;
    delete_provider_secret_internal(&id)
}

/// The keychain half, without the IPC token check — for callers already inside
/// the trusted boundary (uninstall cleanup), mirroring delete_oauth_tokens_internal.
fn delete_provider_secret_internal(id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ─── OAuth sessions (remote MCP) ─────────────────────────────────────────────
// Persisted as a JSON blob per provider under the `cognistore-oauth` service. The
// sidecar's file store (~/.cognistore/oauth-tokens.json) is the source of truth;
// this keychain entry is an at-rest mirror the frontend writes when the app is open.

#[tauri::command]
pub fn set_oauth_tokens(app: tauri::AppHandle, token: String, id: String, value: String) -> Result<(), String> {
    require_token(&app, &token)?;
    keyring::Entry::new(OAUTH_SERVICE, &id)
        .map_err(|e| e.to_string())?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_oauth_tokens(app: tauri::AppHandle, token: String, id: String) -> Result<Option<String>, String> {
    require_token(&app, &token)?;
    let entry = keyring::Entry::new(OAUTH_SERVICE, &id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_oauth_tokens_internal(id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(OAUTH_SERVICE, id).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_oauth_tokens(app: tauri::AppHandle, token: String, id: String) -> Result<(), String> {
    require_token(&app, &token)?;
    delete_oauth_tokens_internal(&id)
}

/// Uninstall symmetry: delete every provider secret AND oauth session named in
/// providers.json, plus the sidecar oauth-tokens.json file.
#[tauri::command]
pub fn cleanup_provider_secrets(app: tauri::AppHandle, token: String) -> Result<(), String> {
    require_token(&app, &token)?;
    if let Some(home) = dirs::home_dir() {
        let cog = home.join(".cognistore");
        let providers_json = cog.join("providers.json");
        for id in provider_ids_from_config(&providers_json) {
            let _ = delete_provider_secret_internal(&id);
            let _ = delete_oauth_tokens_internal(&id);
        }
        // Remove the sidecar OAuth token file (source of truth).
        let _ = fs::remove_file(cog.join("oauth-tokens.json"));
    }
    Ok(())
}
