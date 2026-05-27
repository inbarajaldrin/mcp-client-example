// AgentRegistry — a transport-agnostic automation surface for the MCP client.
//
// Holds two things:
//   (1) a viewState sink: live, debuggable run state written by the client / run
//       engine at meaningful moments (server connect, run phase, gate verdict, errors);
//   (2) an action registry: named, self-describing capabilities that external drivers
//       can discover and invoke.
//
// Both the web adapter (src/web/api.ts) and the CLI adapter (src/cli-client.ts) are
// thin wrappers over this single core, so the two surfaces stay at parity by
// construction — a new action or state key is exposed identically to both.
//
// Reference: element-registry pattern (read-side viewState sink + action registry).
// Gated by MCP_CLIENT_AGENT_API so the surface is inert unless explicitly enabled.

export interface AgentActionParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  required?: boolean;
  description?: string;
}

export interface AgentActionDef {
  id: string; // hierarchical, kebab/dot-cased, e.g. "model.select", "run.start"
  description: string;
  params?: AgentActionParam[];
  handler: (params: Record<string, any>) => Promise<any> | any;
}

export interface AgentActionManifestEntry {
  id: string;
  description: string;
  params: AgentActionParam[];
}

export class AgentRegistry {
  private static _shared: AgentRegistry | null = null;
  static get shared(): AgentRegistry {
    if (!this._shared) this._shared = new AgentRegistry();
    return this._shared;
  }

  private viewState: Record<string, any> = {};
  private actions: Map<string, AgentActionDef> = new Map();

  /**
   * Whether the agent automation surface is enabled. Off unless MCP_CLIENT_AGENT_API
   * is set to a truthy value (1/true/yes). Adapters should consult this before
   * exposing the /agent/* routes or CLI commands.
   */
  isEnabled(): boolean {
    const v = (process.env.MCP_CLIENT_AGENT_API || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }

  // ─── Read side: viewState sink ───
  // Convention: "<surface>.<field>" keys, e.g. "run.phase", "servers.connectError".
  // Setting undefined/null removes the key (so a cleared error disappears from the snapshot).
  setViewState(key: string, value: any): void {
    if (value === undefined || value === null) {
      delete this.viewState[key];
    } else {
      this.viewState[key] = value;
    }
  }

  getViewState(key: string): any {
    return this.viewState[key];
  }

  viewStateSnapshot(): Record<string, any> {
    return { ...this.viewState };
  }

  /** Clear all keys, or just those under a "<prefix>" / "<prefix>.*" namespace. */
  clearViewState(prefix?: string): void {
    if (!prefix) {
      this.viewState = {};
      return;
    }
    for (const k of Object.keys(this.viewState)) {
      if (k === prefix || k.startsWith(prefix + '.')) delete this.viewState[k];
    }
  }

  // ─── Action side: registry ───
  registerAction(def: AgentActionDef): void {
    this.actions.set(def.id, def);
  }

  hasAction(id: string): boolean {
    return this.actions.has(id);
  }

  /** Self-describing manifest (handlers stripped), sorted by id. */
  listActions(): AgentActionManifestEntry[] {
    return Array.from(this.actions.values())
      .map((a) => ({ id: a.id, description: a.description, params: a.params ?? [] }))
      .sort((x, y) => x.id.localeCompare(y.id));
  }

  async invokeAction(
    id: string,
    params: Record<string, any> = {},
  ): Promise<{ ok: boolean; result?: any; error?: string }> {
    const action = this.actions.get(id);
    if (!action) return { ok: false, error: `Unknown action: ${id}` };
    for (const p of action.params ?? []) {
      if (p.required && params[p.name] === undefined) {
        return { ok: false, error: `Missing required param: ${p.name}` };
      }
    }
    try {
      const result = await action.handler(params);
      return { ok: true, result };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }
}
