import { useState } from 'react';
import type { PromptInfo, ResolvedPrompt } from '../hooks/usePrompts';

interface PromptsPanelProps {
  open: boolean;
  onClose: () => void;
  prompts: PromptInfo[];
  loading: boolean;
  error: string | null;
  onToggle: (server: string, name: string, enabled: boolean) => void;
  onGetPrompt: (server: string, name: string, args?: Record<string, string>) => Promise<ResolvedPrompt | null>;
  onUsePrompt: (server: string, name: string, args?: Record<string, string>) => Promise<boolean>;
}

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
    // Check required args
    for (const arg of prompt.arguments) {
      if (arg.required && !args[arg.name]?.trim()) return;
    }
    onSubmit(args);
  };

  if (prompt.arguments.length === 0) {
    // No args needed, submit immediately
    return (
      <div className="prompt-args">
        <div className="prompt-args__actions">
          <button className="btn-sm" onClick={() => onSubmit({})}>
            {submitLabel}
          </button>
          <button className="btn-sm" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="prompt-args">
      {prompt.arguments.map(arg => (
        <label key={arg.name} className="prompt-args__field">
          <span className="prompt-args__label">
            {arg.name}
            {arg.required && <span className="prompt-args__required">*</span>}
          </span>
          {arg.description && <span className="prompt-args__hint">{arg.description}</span>}
          <input
            className="prompt-args__input"
            type="text"
            value={args[arg.name] || ''}
            onChange={e => setArgs(prev => ({ ...prev, [arg.name]: e.target.value }))}
            placeholder={arg.required ? 'Required' : 'Optional'}
          />
        </label>
      ))}
      <div className="prompt-args__actions">
        <button className="btn-sm" onClick={handleSubmit}>{submitLabel}</button>
        <button className="btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function PromptsPanel({
  open, onClose, prompts, loading, error,
  onToggle, onGetPrompt, onUsePrompt,
}: PromptsPanelProps) {
  const [activePrompt, setActivePrompt] = useState<{ prompt: PromptInfo; mode: 'preview' | 'use' } | null>(null);
  const [preview, setPreview] = useState<ResolvedPrompt | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);

  if (!open) return null;

  // Group by server
  const byServer = new Map<string, PromptInfo[]>();
  for (const p of prompts) {
    const list = byServer.get(p.server) || [];
    list.push(p);
    byServer.set(p.server, list);
  }

  const handlePreview = async (args: Record<string, string>) => {
    if (!activePrompt) return;
    setActionLoading(true);
    setPreview(null);
    const result = await onGetPrompt(activePrompt.prompt.server, activePrompt.prompt.name, Object.keys(args).length > 0 ? args : undefined);
    setPreview(result);
    setActionLoading(false);
  };

  const handleUse = async (args: Record<string, string>) => {
    if (!activePrompt) return;
    setActionLoading(true);
    const ok = await onUsePrompt(activePrompt.prompt.server, activePrompt.prompt.name, Object.keys(args).length > 0 ? args : undefined);
    setActionLoading(false);
    if (ok) {
      setActionResult(`Added "${activePrompt.prompt.name}" to context`);
      setActivePrompt(null);
      setTimeout(() => setActionResult(null), 3000);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel--lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Prompts</span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {error && <div className="settings-error">{error}</div>}
          {actionResult && <div className="prompt-success">{actionResult}</div>}

          {loading ? (
            <div className="chat-history__loading">Loading...</div>
          ) : prompts.length === 0 ? (
            <div className="chat-history__empty">No prompts available from any server</div>
          ) : (
            <div className="prompts-list">
              {Array.from(byServer.entries()).map(([server, serverPrompts]) => (
                <div key={server} className="prompts-server">
                  <div className="prompts-server__header">{server}</div>
                  {serverPrompts.map(p => (
                    <div key={`${p.server}__${p.name}`} className="prompts-item">
                      <div className="prompts-item__header">
                        <input
                          type="checkbox"
                          className="tool-item__checkbox"
                          checked={p.enabled}
                          onChange={() => onToggle(p.server, p.name, !p.enabled)}
                        />
                        <div className="prompts-item__info">
                          <div className="prompts-item__name">{p.name}</div>
                          {p.description && <div className="prompts-item__desc">{p.description}</div>}
                          {p.arguments.length > 0 && (
                            <div className="prompts-item__args-count">
                              {p.arguments.length} arg{p.arguments.length > 1 ? 's' : ''}
                            </div>
                          )}
                        </div>
                        <div className="prompts-item__actions">
                          <button
                            className="btn-sm"
                            onClick={() => { setActivePrompt({ prompt: p, mode: 'preview' }); setPreview(null); }}
                            disabled={!p.enabled}
                          >
                            Preview
                          </button>
                          <button
                            className="btn-sm"
                            onClick={() => { setActivePrompt({ prompt: p, mode: 'use' }); setPreview(null); }}
                            disabled={!p.enabled}
                          >
                            Use
                          </button>
                        </div>
                      </div>

                      {activePrompt && activePrompt.prompt.name === p.name && activePrompt.prompt.server === p.server && (
                        <div className="prompts-item__form">
                          {actionLoading ? (
                            <div className="chat-history__loading">Loading...</div>
                          ) : (
                            <PromptArgForm
                              prompt={p}
                              onSubmit={activePrompt.mode === 'preview' ? handlePreview : handleUse}
                              onCancel={() => { setActivePrompt(null); setPreview(null); }}
                              submitLabel={activePrompt.mode === 'preview' ? 'Preview' : 'Add to Context'}
                            />
                          )}

                          {preview && activePrompt.mode === 'preview' && (
                            <div className="prompt-preview">
                              <div className="prompt-preview__label">Preview ({preview.messages.length} message{preview.messages.length !== 1 ? 's' : ''})</div>
                              {preview.messages.map((m, i) => (
                                <div key={i} className="prompt-preview__msg">
                                  <span className="prompt-preview__role">{m.role}</span>
                                  <span className="prompt-preview__text">{m.content.slice(0, 500)}{m.content.length > 500 ? '...' : ''}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
