/**
 * Governance graph: items (anything a host manages: agents, models, users, policies, approval rules ...) and links between them.
 * The graph is host-neutral. An adapter fills it from the host's own APIs.
 */

export interface Item {
  id: string;
  /** Item type, e.g. "Agent", "Model", "ApprovalRule". Types come from the adapter, Aegis does not fix a list. */
  type: string;
  title: string;
  props: Record<string, unknown>;
  /** Where the item lives in the host: the source it was read from and its key there (fills path params of host actions). */
  ref?: { source: string; key: string };
}

export interface Link {
  /** Relation name, e.g. "uses", "owns", "approves". */
  type: string;
  from: string;
  to: string;
}

export interface Snapshot {
  items: Item[];
  links: Link[];
}

export class Graph {
  readonly items: Item[];
  readonly links: Link[];
  private readonly byId = new Map<string, Item>();
  private readonly outIdx = new Map<string, Link[]>();
  private readonly inIdx = new Map<string, Link[]>();

  constructor(snapshot: Snapshot) {
    this.items = snapshot.items;
    this.links = snapshot.links;
    for (const it of this.items) this.byId.set(it.id, it);
    for (const l of this.links) {
      if (!this.outIdx.has(l.from)) this.outIdx.set(l.from, []);
      if (!this.inIdx.has(l.to)) this.inIdx.set(l.to, []);
      this.outIdx.get(l.from)!.push(l);
      this.inIdx.get(l.to)!.push(l);
    }
  }

  get(id: string): Item | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  ofType(type: string): Item[] {
    return this.items.filter((x) => x.type === type);
  }

  types(): string[] {
    return [...new Set(this.items.map((x) => x.type))];
  }

  /** Items this item points to (optionally by relation). */
  out(id: string, rel?: string): Item[] {
    return (this.outIdx.get(id) ?? []).filter((l) => !rel || l.type === rel).map((l) => this.byId.get(l.to)).filter((x): x is Item => !!x);
  }

  /** Items pointing to this item (optionally by relation). */
  in(id: string, rel?: string): Item[] {
    return (this.inIdx.get(id) ?? []).filter((l) => !rel || l.type === rel).map((l) => this.byId.get(l.from)).filter((x): x is Item => !!x);
  }

  /** Directly linked items, both directions, without duplicates. */
  neighbors(id: string): Item[] {
    const seen = new Map<string, Item>();
    for (const x of [...this.out(id), ...this.in(id)]) if (x.id !== id) seen.set(x.id, x);
    return [...seen.values()];
  }
}
