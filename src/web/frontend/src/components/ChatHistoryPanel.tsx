import { useState, useEffect } from 'react';
import type { ChatMeta } from '../hooks/useChatHistory';

interface ChatHistoryPanelProps {
  open: boolean;
  onClose: () => void;
  chats: ChatMeta[];
  loading: boolean;
  error: string | null;
  onFetch: () => void;
  onSearch: (q: string) => void;
  onRestore: (id: string) => Promise<boolean>;
  onExport: (id: string, format: 'json' | 'md') => Promise<any>;
  onDelete: (id: string) => Promise<boolean>;
}

function formatDuration(ms?: number): string {
  if (!ms) return '-';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ChatHistoryPanel({
  open, onClose, chats, loading, error,
  onFetch, onSearch, onRestore, onExport, onDelete,
}: ChatHistoryPanelProps) {
  const [query, setQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (open) onFetch();
  }, [open, onFetch]);

  if (!open) return null;

  const handleSearch = (val: string) => {
    setQuery(val);
    onSearch(val);
  };

  const handleRestore = async (id: string) => {
    const ok = await onRestore(id);
    if (ok) onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel--lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Chat History</span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          <input
            className="chat-history__search"
            type="text"
            placeholder="Search chats..."
            value={query}
            onChange={e => handleSearch(e.target.value)}
          />

          {error && <div className="settings-error">{error}</div>}

          {loading ? (
            <div className="chat-history__loading">Loading...</div>
          ) : chats.length === 0 ? (
            <div className="chat-history__empty">No chat sessions found</div>
          ) : (
            <div className="chat-history__list">
              {chats.map(chat => (
                <div key={chat.sessionId} className="chat-history__item">
                  <div className="chat-history__item-header">
                    <span className="chat-history__date">{formatDate(chat.startTime)}</span>
                    <span className="chat-history__model">{chat.model}</span>
                  </div>
                  <div className="chat-history__item-meta">
                    <span>{chat.messageCount} msgs</span>
                    <span>{chat.toolUseCount} tools</span>
                    <span>{formatDuration(chat.duration)}</span>
                  </div>
                  <div className="chat-history__item-actions">
                    <button className="btn-sm" onClick={() => handleRestore(chat.sessionId)}>Restore</button>
                    <button className="btn-sm" onClick={() => onExport(chat.sessionId, 'json')}>JSON</button>
                    <button className="btn-sm" onClick={() => onExport(chat.sessionId, 'md')}>MD</button>
                    {confirmDelete === chat.sessionId ? (
                      <>
                        <button className="btn-sm btn-sm--danger" onClick={() => { onDelete(chat.sessionId); setConfirmDelete(null); }}>Confirm</button>
                        <button className="btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn-sm btn-sm--danger" onClick={() => setConfirmDelete(chat.sessionId)}>Delete</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
