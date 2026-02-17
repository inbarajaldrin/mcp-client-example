import { useState } from 'react';
import type { PromptInfo, ResolvedPrompt } from '../hooks/usePrompts';

interface ToolWithState {
  name: string;
  server: string;
  description: string;
  enabled: boolean;
}

interface ServerInfo {
  name: string;
  tools: Array<{ name: string; description: string }>;
}

interface ServerPanelProps {
  servers: ServerInfo[];
  allTools: ToolWithState[];
  loading: boolean;
  onToggleTool: (toolName: string, enabled: boolean) => void;
  onToggleServer: (serverName: string, enabled: boolean) => void;
  prompts: PromptInfo[];
  promptsLoading: boolean;
  onTogglePrompt: (server: string, name: string, enabled: boolean) => void;
  onGetPrompt: (server: string, name: string, args?: Record<string, string>) => Promise<ResolvedPrompt | null>;
  onUsePrompt: (server: string, name: string, args?: Record<string, string>) => Promise<boolean>;
}

function ServerItem({
  server,
  serverTools,
  onToggleTool,
  onToggleServer,
}: {
  server: string;
  serverTools: ToolWithState[];
  onToggleTool: (toolName: string, enabled: boolean) => void;
  onToggleServer: (serverName: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  const cleanToolName = (name: string) =>
    name.includes('__') ? name.split('__').slice(1).join('__') : name;

  const enabledCount = serverTools.filter(t => t.enabled).length;
  const allEnabled = enabledCount === serverTools.length;
  const someEnabled = enabledCount > 0 && !allEnabled;

  return (
    <div className="server-item">
      <div className="server-item__header">
        <input
          type="checkbox"
          className="server-item__checkbox"
          checked={allEnabled}
          ref={el => { if (el) el.indeterminate = someEnabled; }}
          onChange={() => onToggleServer(server, !allEnabled)}
          title={allEnabled ? 'Disable all tools' : 'Enable all tools'}
        />
        <span
          className={`server-item__chevron ${open ? 'server-item__chevron--open' : ''}`}
          onClick={() => setOpen(!open)}
        >
          &#9654;
        </span>
        <span className="server-item__name" onClick={() => setOpen(!open)}>{server}</span>
        <span className="server-item__badge">{enabledCount}/{serverTools.length}</span>
      </div>
      <div className={`server-item__tools ${open ? 'server-item__tools--open' : ''}`}>
        {serverTools.map(tool => (
          <div key={tool.name} className="tool-item">
            <input
              type="checkbox"
              className="tool-item__checkbox"
              checked={tool.enabled}
              onChange={() => onToggleTool(tool.name, !tool.enabled)}
            />
            <div className="tool-item__info">
              <div className="tool-item__name">{cleanToolName(tool.name)}</div>
              {tool.description && (
                <div className="tool-item__desc">{tool.description}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Prompt items within server entries ───

function PromptArgForm({
  prompt,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  prompt: PromptInfo;
  onSubmit: (args: Record<string, string>) => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [args, setArgs] = useState<Record<string, string>>({});

  const handleSubmit = () => {
    for (const arg of prompt.arguments) {
      if (arg.required && !args[arg.name]?.trim()) return;
    }
    onSubmit(args);
  };

  if (prompt.arguments.length === 0) {
    return (
      <div className="sidebar-prompt__form-actions">
        <button className="btn-sm" onClick={() => onSubmit({})}>{submitLabel}</button>
        <button className="btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="sidebar-prompt__form">
      {prompt.arguments.map(arg => (
        <label key={arg.name} className="sidebar-prompt__arg">
          <span className="sidebar-prompt__arg-label">
            {arg.name}
            {arg.required && <span className="sidebar-prompt__arg-req">*</span>}
          </span>
          <input
            className="sidebar-prompt__arg-input"
            type="text"
            value={args[arg.name] || ''}
            onChange={e => setArgs(prev => ({ ...prev, [arg.name]: e.target.value }))}
            placeholder={arg.required ? 'Required' : 'Optional'}
          />
        </label>
      ))}
      <div className="sidebar-prompt__form-actions">
        <button className="btn-sm" onClick={handleSubmit}>{submitLabel}</button>
        <button className="btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function PromptItemRow({
  prompt,
  onToggle,
  onGetPrompt,
  onUsePrompt,
}: {
  prompt: PromptInfo;
  onToggle: (server: string, name: string, enabled: boolean) => void;
  onGetPrompt: (server: string, name: string, args?: Record<string, string>) => Promise<ResolvedPrompt | null>;
  onUsePrompt: (server: string, name: string, args?: Record<string, string>) => Promise<boolean>;
}) {
  const [activeMode, setActiveMode] = useState<'preview' | 'use' | null>(null);
  const [preview, setPreview] = useState<ResolvedPrompt | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handlePreview = async (args: Record<string, string>) => {
    setActionLoading(true);
    setPreview(null);
    const r = await onGetPrompt(prompt.server, prompt.name, Object.keys(args).length > 0 ? args : undefined);
    setPreview(r);
    setActionLoading(false);
  };

  const handleUse = async (args: Record<string, string>) => {
    setActionLoading(true);
    const ok = await onUsePrompt(prompt.server, prompt.name, Object.keys(args).length > 0 ? args : undefined);
    setActionLoading(false);
    if (ok) {
      setResult('Added to context');
      setActiveMode(null);
      setTimeout(() => setResult(null), 3000);
    }
  };

  return (
    <div className="tool-item sidebar-prompt">
      <div className="sidebar-prompt__row">
        <input
          type="checkbox"
          className="tool-item__checkbox"
          checked={prompt.enabled}
          onChange={() => onToggle(prompt.server, prompt.name, !prompt.enabled)}
        />
        <div className="tool-item__info">
          <div className="tool-item__name">{prompt.name}</div>
          {prompt.description && <div className="tool-item__desc">{prompt.description}</div>}
        </div>
      </div>
      {prompt.enabled && (
        <div className="sidebar-prompt__actions">
          <button
            className="btn-sm"
            onClick={() => { setActiveMode(activeMode === 'preview' ? null : 'preview'); setPreview(null); }}
          >
            Preview
          </button>
          <button
            className="btn-sm"
            onClick={() => { setActiveMode(activeMode === 'use' ? null : 'use'); setPreview(null); }}
          >
            Use
          </button>
        </div>
      )}
      {result && <div className="sidebar-prompt__result">{result}</div>}
      {activeMode && (
        <div className="sidebar-prompt__expand">
          {actionLoading ? (
            <div className="server-panel__loading">Loading...</div>
          ) : (
            <PromptArgForm
              prompt={prompt}
              onSubmit={activeMode === 'preview' ? handlePreview : handleUse}
              onCancel={() => { setActiveMode(null); setPreview(null); }}
              submitLabel={activeMode === 'preview' ? 'Preview' : 'Add to Context'}
            />
          )}
          {preview && activeMode === 'preview' && (
            <div className="sidebar-prompt__preview">
              <div className="sidebar-prompt__preview-label">
                {preview.messages.length} message{preview.messages.length !== 1 ? 's' : ''}
              </div>
              {preview.messages.map((m, i) => (
                <div key={i} className="sidebar-prompt__preview-msg">
                  <span className="sidebar-prompt__preview-role">{m.role}</span>
                  <span className="sidebar-prompt__preview-text">
                    {m.content.slice(0, 300)}{m.content.length > 300 ? '...' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PromptServerItem({
  server,
  serverPrompts,
  onTogglePrompt,
  onGetPrompt,
  onUsePrompt,
}: {
  server: string;
  serverPrompts: PromptInfo[];
  onTogglePrompt: (server: string, name: string, enabled: boolean) => void;
  onGetPrompt: (server: string, name: string, args?: Record<string, string>) => Promise<ResolvedPrompt | null>;
  onUsePrompt: (server: string, name: string, args?: Record<string, string>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);

  const enabledCount = serverPrompts.filter(p => p.enabled).length;
  const allEnabled = enabledCount === serverPrompts.length;
  const someEnabled = enabledCount > 0 && !allEnabled;

  const toggleAll = () => {
    const newEnabled = !allEnabled;
    for (const p of serverPrompts) {
      onTogglePrompt(p.server, p.name, newEnabled);
    }
  };

  return (
    <div className="server-item">
      <div className="server-item__header">
        <input
          type="checkbox"
          className="server-item__checkbox"
          checked={allEnabled}
          ref={el => { if (el) el.indeterminate = someEnabled; }}
          onChange={toggleAll}
          title={allEnabled ? 'Disable all prompts' : 'Enable all prompts'}
        />
        <span
          className={`server-item__chevron ${open ? 'server-item__chevron--open' : ''}`}
          onClick={() => setOpen(!open)}
        >
          &#9654;
        </span>
        <span className="server-item__name" onClick={() => setOpen(!open)}>{server}</span>
        <span className="server-item__type-badge">prompts</span>
        <span className="server-item__badge">{enabledCount}/{serverPrompts.length}</span>
      </div>
      <div className={`server-item__tools ${open ? 'server-item__tools--open' : ''}`}>
        {serverPrompts.map(p => (
          <PromptItemRow
            key={`${p.server}__${p.name}`}
            prompt={p}
            onToggle={onTogglePrompt}
            onGetPrompt={onGetPrompt}
            onUsePrompt={onUsePrompt}
          />
        ))}
      </div>
    </div>
  );
}

export function ServerPanel({
  allTools, loading, onToggleTool, onToggleServer,
  prompts, promptsLoading, onTogglePrompt, onGetPrompt, onUsePrompt,
}: ServerPanelProps) {
  // Group tools by server
  const serverMap = new Map<string, ToolWithState[]>();
  for (const tool of allTools) {
    const list = serverMap.get(tool.server) || [];
    list.push(tool);
    serverMap.set(tool.server, list);
  }
  const serverNames = Array.from(serverMap.keys());

  // Group prompts by server (only servers that have prompts)
  const promptsByServer = new Map<string, PromptInfo[]>();
  for (const p of prompts) {
    const list = promptsByServer.get(p.server) || [];
    list.push(p);
    promptsByServer.set(p.server, list);
  }

  return (
    <div className="server-panel">
      <div className="server-panel__label">Servers</div>
      {loading ? (
        <div className="server-panel__loading">Connecting...</div>
      ) : serverNames.length === 0 && prompts.length === 0 ? (
        <div className="server-panel__empty">No servers connected</div>
      ) : (
        <>
          {serverNames.map(name => (
            <ServerItem
              key={name}
              server={name}
              serverTools={serverMap.get(name)!}
              onToggleTool={onToggleTool}
              onToggleServer={onToggleServer}
            />
          ))}
          {!promptsLoading && Array.from(promptsByServer.entries()).map(([server, serverPrompts]) => (
            <PromptServerItem
              key={`prompts-${server}`}
              server={server}
              serverPrompts={serverPrompts}
              onTogglePrompt={onTogglePrompt}
              onGetPrompt={onGetPrompt}
              onUsePrompt={onUsePrompt}
            />
          ))}
        </>
      )}
    </div>
  );
}
