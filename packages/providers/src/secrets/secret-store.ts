/** Resolves a provider credential by its `secretRef` (the provider id). */
export interface ISecretStore {
  get(secretRef: string): Promise<string | null>;
}
