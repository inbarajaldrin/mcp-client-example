import { useState, useEffect } from 'react';
import type { Settings } from '../hooks/useSettings';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: Settings | null;
  onSave: (partial: Partial<Settings>) => Promise<boolean>;
  error: string | null;
  orchestratorConfigured?: boolean;
  orchestratorEnabled?: boolean;
  onToggleOrchestrator?: () => void;
  todoConfigured?: boolean;
  todoEnabled?: boolean;
  onToggleTodo?: () => void;
}

export function SettingsModal({ open, onClose, settings, onSave, error, orchestratorConfigured, orchestratorEnabled, onToggleOrchestrator, todoConfigured, todoEnabled, onToggleTodo }: SettingsModalProps) {
  const [mcpTimeout, setMcpTimeout] = useState('');
  const [maxIterations, setMaxIterations] = useState('');
  const [hilEnabled, setHilEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setMcpTimeout(settings.mcpTimeout === -1 ? 'unlimited' : String(settings.mcpTimeout));
      setMaxIterations(settings.maxIterations === -1 ? 'unlimited' : String(settings.maxIterations));
      setHilEnabled(settings.hilEnabled);
    }
  }, [settings]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    const partial: Partial<Settings> = { hilEnabled };
    if (mcpTimeout.toLowerCase().trim() === 'unlimited') {
      partial.mcpTimeout = -1;
    } else {
      const v = parseInt(mcpTimeout, 10);
      if (!isNaN(v)) partial.mcpTimeout = v;
    }
    if (maxIterations.toLowerCase().trim() === 'unlimited') {
      partial.maxIterations = -1;
    } else {
      const v = parseInt(maxIterations, 10);
      if (!isNaN(v)) partial.maxIterations = v;
    }
    const ok = await onSave(partial);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Settings</span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          <label className="settings-field">
            <span className="settings-field__label">MCP Timeout (seconds)</span>
            <input
              className="settings-field__input"
              type="text"
              value={mcpTimeout}
              onChange={e => setMcpTimeout(e.target.value)}
              placeholder="60 or unlimited"
            />
            <span className="settings-field__hint">1–3600 or "unlimited"</span>
          </label>

          <label className="settings-field">
            <span className="settings-field__label">Max Iterations</span>
            <input
              className="settings-field__input"
              type="text"
              value={maxIterations}
              onChange={e => setMaxIterations(e.target.value)}
              placeholder="100 or unlimited"
            />
            <span className="settings-field__hint">1–10000 or "unlimited"</span>
          </label>

          <label className="settings-field settings-field--toggle">
            <span className="settings-field__label">Human-in-the-Loop</span>
            <button
              type="button"
              className={`toggle-switch ${hilEnabled ? 'toggle-switch--on' : ''}`}
              onClick={() => setHilEnabled(!hilEnabled)}
              role="switch"
              aria-checked={hilEnabled}
            >
              <span className="toggle-switch__knob" />
            </button>
          </label>

          {orchestratorConfigured && (
            <label className="settings-field settings-field--toggle">
              <span className="settings-field__label">
                Orchestrator Mode
                <span className="settings-field__hint" style={{ display: 'block', marginTop: 2 }}>
                  Enable IPC server for sub-agent tool calls
                </span>
              </span>
              <button
                type="button"
                className={`toggle-switch ${orchestratorEnabled ? 'toggle-switch--on' : ''}`}
                onClick={onToggleOrchestrator}
                role="switch"
                aria-checked={orchestratorEnabled}
              >
                <span className="toggle-switch__knob" />
              </button>
            </label>
          )}

          {todoConfigured && (
            <label className="settings-field settings-field--toggle">
              <span className="settings-field__label">
                Todo Mode
                <span className="settings-field__hint" style={{ display: 'block', marginTop: 2 }}>
                  Decompose tasks into actionable todos
                </span>
              </span>
              <button
                type="button"
                className={`toggle-switch ${todoEnabled ? 'toggle-switch--on' : ''}`}
                onClick={onToggleTodo}
                role="switch"
                aria-checked={todoEnabled}
              >
                <span className="toggle-switch__knob" />
              </button>
            </label>
          )}

          {error && <div className="settings-error">{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn-modal btn-modal--cancel" onClick={onClose}>Cancel</button>
          <button className="btn-modal btn-modal--save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
