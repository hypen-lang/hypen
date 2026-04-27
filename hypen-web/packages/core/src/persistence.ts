/**
 * State Persistence Layer
 *
 * Pluggable persistence interface for Hypen modules.
 * Modules opt in with `.persist(adapter)` on the builder.
 * The runtime handles save/restore lifecycle transparently.
 */

export interface StateStore<T = unknown> {
  /**
   * Resolve the storage key for this module instance.
   * Called on init and whenever state changes (for withKey).
   * Returns null = no persistence active.
   */
  resolveKey(state: T, moduleName: string, sessionId: string): string | null;

  /** Load persisted state. Called when key first resolves to non-null. */
  load(key: string): Promise<T | null>;

  /** Save state. Called on mutation (debounced by runtime). */
  save(key: string, state: T): Promise<void>;

  /** Delete persisted state. Called on session expire. */
  delete(key: string): Promise<void>;
}
