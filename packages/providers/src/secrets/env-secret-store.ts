import type { ISecretStore } from './secret-store.js';

/**
 * Map a secretRef to the env var the Tauri shell injects from the OS keychain.
 * This sanitization MUST stay identical to the Rust side (sidecar env injection).
 */
export function secretRefToEnvKey(secretRef: string): string {
  return 'COGNISTORE_PROVIDER_SECRET__' + secretRef.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Reads provider secrets from process env. The Tauri app reads the OS keychain
 * (Rust, the only keychain-touching process) and injects
 * `COGNISTORE_PROVIDER_SECRET__<ID>` into the sidecar and the MCP subprocess.
 */
export class EnvSecretStore implements ISecretStore {
  async get(secretRef: string): Promise<string | null> {
    return process.env[secretRefToEnvKey(secretRef)] ?? null;
  }
}
