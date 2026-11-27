/**
 * The only host-specific part. An adapter reads the host, turns what it read into the governance graph, lists the host's
 * screens and performs approved calls. Everything else in Aegis works from what the adapter returns.
 */

import type { Action } from './actions.ts';
import type { Snapshot } from './graph.ts';
import type { RawRead } from './provenance.ts';
import type { Screen } from './screens.ts';

export interface HostAdapter {
  /** Read every source once (the same APIs the host's own screens call). */
  read(): Promise<RawRead>;
  /** Turn a raw read into items and links. Must be pure: same read, same graph. */
  toGraph(raw: RawRead): Snapshot;
  /** Display names of item types in the host's language (optional). */
  labels?: Record<string, string>;
  /** The host's screens, e.g. from its screen contracts. */
  screens(): Promise<Screen[]>;
  /**
   * Perform one host call after approval. `input` is what the person gave; the adapter builds the host request body from it
   * (it knows the host API, e.g. by `action.operation`). Optional: without it Aegis only proposes.
   */
  call?(method: string, path: string, input: unknown, action: Action): Promise<unknown>;
}
