import { useState, useEffect } from 'react';
import type { ClientHook } from '../hooks/useHooks';

interface HooksPanelProps {
  open: boolean;
  onClose: () => void;
  hooks: ClientHook[];
  loading: boolean;
  error: string | null;
  onFetch: () => void;
  onAdd: (hook: Omit<ClientHook, 'id'>) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  onToggle: (id: string, enabled: boolean) => Promise<boolean>;
  onReload: () => void;
}

type View = 'list' | 'add';

export function HooksPanel({
  open, onClose, hooks, loading, error,
  onFetch, onAdd, onRemove, onToggle, onReload,
}: HooksPanelProps) {
  const [view, setView] = useState<View>('list');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Add form state
  const [triggerType, setTriggerType] = useState<'after' | 'before'>('after');
  const [toolName, setToolName] = useState('');
  const [whenStr, setWhenStr] = useState('');
  const [runCmd, setRunCmd] = useState('');
  const [description, setDescription] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (open) onFetch();
  }, [open, onFetch]);

  if (!open) return null;

  const resetForm = () => {
    setTriggerType('after');
    setToolName('');
    setWhenStr('');
    setRunCmd('');
    setDescription('');
  };

  const handleAdd = async () => {
    if (!toolName.trim() || !runCmd.trim()) return;
    setAdding(true);

    let when: Record<string, unknown> | undefined;
    if (whenStr.trim()) {
      try {
        when = JSON.parse(whenStr.trim());
      } catch {
        // ignore invalid JSON
      }
    }

    const hook: Omit<ClientHook, 'id'> = {
      run: runCmd.trim(),
      enabled: true,
      ...(triggerType === 'after' ? { after: toolName.trim() } : { before: toolName.trim() }),
      ...(when && { when }),
      ...(description.trim() && { description: description.trim() }),
    };

    const ok = await onAdd(hook);
    setAdding(false);
    if (ok) {
      resetForm();
      setView('list');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel--lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            {view === 'list' ? 'Client Hooks' : 'Add Hook'}
          </span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {view === 'list' && (
              <>
                <button className="btn-sm" onClick={onReload} title="Reload from disk">Reload</button>
                <button className="btn-sm hooks-add-btn" onClick={() => setView('add')}>+ Add</button>
              </>
            )}
            {view === 'add' && (
              <button className="btn-sm" onClick={() => { resetForm(); setView('list'); }}>Back</button>
            )}
            <button className="modal-close" onClick={onClose}>&times;</button>
          </div>
        </div>

        <div className="modal-body">
          {error && <div className="hooks-error">{error}</div>}

          {view === 'list' && (
            loading ? (
              <div className="chat-history__loading">Loading...</div>
            ) : hooks.length === 0 ? (
              <div className="chat-history__empty">
                No hooks configured. Click + Add to create one, or edit .mcp-client-data/hooks.yaml directly.
              </div>
            ) : (
              <div className="hooks-list">
                {hooks.map(hook => (
                  <div key={hook.id} className={`hooks-item ${!hook.enabled ? 'hooks-item--disabled' : ''}`}>
                    <div className="hooks-item__header">
                      <div className="hooks-item__trigger">
                        <span className={`hooks-item__badge hooks-item__badge--${hook.after ? 'after' : 'before'}`}>
                          {hook.after ? 'after' : 'before'}
                        </span>
                        <span className="hooks-item__tool-name">{hook.after || hook.before}</span>
                      </div>
                      <div className="hooks-item__actions">
                        <button
                          className={`hooks-toggle ${hook.enabled ? 'hooks-toggle--on' : ''}`}
                          onClick={() => onToggle(hook.id, !hook.enabled)}
                          title={hook.enabled ? 'Disable' : 'Enable'}
                        >
                          <span className="hooks-toggle__knob" />
                        </button>
                        {confirmDelete === hook.id ? (
                          <span className="hooks-item__confirm">
                            <button className="btn-sm hooks-btn--danger" onClick={async () => { await onRemove(hook.id); setConfirmDelete(null); }}>
                              Confirm
                            </button>
                            <button className="btn-sm" onClick={() => setConfirmDelete(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button className="btn-sm hooks-btn--danger" onClick={() => setConfirmDelete(hook.id)} title="Remove">
                            &times;
                          </button>
                        )}
                      </div>
                    </div>
                    {hook.when && (
                      <div className="hooks-item__when">
                        when: <code>{JSON.stringify(hook.when)}</code>
                      </div>
                    )}
                    <div className="hooks-item__run">
                      <code>{hook.run}</code>
                    </div>
                    {hook.description && (
                      <div className="hooks-item__desc">{hook.description}</div>
                    )}
                    <div className="hooks-item__id">id: {hook.id}</div>
                  </div>
                ))}
              </div>
            )
          )}

          {view === 'add' && (
            <div className="hooks-form">
              <div className="hooks-form__field">
                <label className="hooks-form__label">Trigger Type</label>
                <div className="hooks-form__radio-group">
                  <label className={`hooks-form__radio ${triggerType === 'after' ? 'hooks-form__radio--active' : ''}`}>
                    <input type="radio" checked={triggerType === 'after'} onChange={() => setTriggerType('after')} />
                    After
                  </label>
                  <label className={`hooks-form__radio ${triggerType === 'before' ? 'hooks-form__radio--active' : ''}`}>
                    <input type="radio" checked={triggerType === 'before'} onChange={() => setTriggerType('before')} />
                    Before
                  </label>
                </div>
              </div>

              <div className="hooks-form__field">
                <label className="hooks-form__label">Tool Name (trigger)</label>
                <input
                  className="hooks-form__input"
                  value={toolName}
                  onChange={e => setToolName(e.target.value)}
                  placeholder="e.g. ros-mcp-server__signal_phase_complete"
                />
              </div>

              <div className="hooks-form__field">
                <label className="hooks-form__label">When Condition (optional JSON)</label>
                <input
                  className="hooks-form__input"
                  value={whenStr}
                  onChange={e => setWhenStr(e.target.value)}
                  placeholder='e.g. {"phase": 1, "status": "success"}'
                />
              </div>

              <div className="hooks-form__field">
                <label className="hooks-form__label">Run Command</label>
                <input
                  className="hooks-form__input"
                  value={runCmd}
                  onChange={e => setRunCmd(e.target.value)}
                  placeholder="e.g. @tool-exec:isaac-sim__randomize_object_poses()"
                />
              </div>

              <div className="hooks-form__field">
                <label className="hooks-form__label">Description (optional)</label>
                <input
                  className="hooks-form__input"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Human-readable description"
                />
              </div>

              <div className="hooks-form__actions">
                <button
                  className="btn-modal"
                  onClick={handleAdd}
                  disabled={adding || !toolName.trim() || !runCmd.trim()}
                >
                  {adding ? 'Adding...' : 'Add Hook'}
                </button>
                <button className="btn-modal btn-modal--cancel" onClick={() => { resetForm(); setView('list'); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
