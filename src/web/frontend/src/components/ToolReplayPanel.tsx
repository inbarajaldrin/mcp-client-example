import { useState, useEffect } from 'react';
import type { ReplayableToolCall } from '../hooks/useToolReplay';

interface ToolReplayPanelProps {
  open: boolean;
  onClose: () => void;
  calls: ReplayableToolCall[];
  loading: boolean;
  executing: string | null;
  lastResult: string | null;
  onFetch: () => void;
  onExecute: (toolName: string, toolInput: Record<string, any>) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ToolReplayPanel({
  open, onClose, calls, loading, executing, lastResult,
  onFetch, onExecute,
}: ToolReplayPanelProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  useEffect(() => {
    if (open) onFetch();
  }, [open, onFetch]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel--lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Tool Replay</span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="chat-history__loading">Loading...</div>
          ) : calls.length === 0 ? (
            <div className="chat-history__empty">No tool calls in current session</div>
          ) : (
            <div className="tool-replay__list">
              {calls.map((call, idx) => (
                <div key={idx} className="tool-replay__item">
                  <div className="tool-replay__item-header" onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}>
                    <span className="tool-replay__tool-name">{call.toolName}</span>
                    <span className="tool-replay__time">{formatTime(call.timestamp)}</span>
                    <span className="tool-replay__expand">{expandedIdx === idx ? '−' : '+'}</span>
                  </div>
                  {expandedIdx === idx && (
                    <div className="tool-replay__detail">
                      <div className="tool-replay__section">
                        <div className="tool-replay__section-label">Input</div>
                        <pre className="tool-replay__code">{JSON.stringify(call.toolInput, null, 2)}</pre>
                      </div>
                      <button
                        className="btn-sm tool-replay__run-btn"
                        onClick={() => onExecute(call.toolName, call.toolInput)}
                        disabled={executing !== null}
                      >
                        {executing === call.toolName ? 'Running...' : 'Re-execute'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {lastResult && (
            <div className="tool-replay__result">
              <div className="tool-replay__result-header">Replay Result</div>
              <pre className="tool-replay__result-body">{lastResult}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
