import { useState, useCallback } from 'react';

export interface ChatMeta {
  sessionId: string;
  startTime: string;
  endTime?: string;
  duration?: number;
  messageCount: number;
  toolUseCount: number;
  model: string;
  servers: string[];
  tags?: string[];
}

export function useChatHistory() {
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchChats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/chats');
      const data = await res.json();
      setChats(data);
      setError(null);
    } catch {
      setError('Failed to load chat history');
    } finally {
      setLoading(false);
    }
  }, []);

  const searchChats = useCallback(async (query: string) => {
    if (!query.trim()) {
      fetchChats();
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/chats/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      setChats(data);
      setError(null);
    } catch {
      setError('Search failed');
    } finally {
      setLoading(false);
    }
  }, [fetchChats]);

  const restoreChat = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/chats/${sessionId}/restore`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Restore failed' }));
        setError(data.error);
        return false;
      }
      return true;
    } catch {
      setError('Restore failed');
      return false;
    }
  }, []);

  const exportChat = useCallback(async (sessionId: string, format: 'json' | 'md' = 'json') => {
    try {
      const res = await fetch(`/api/chats/${sessionId}/export?format=${format}`);
      if (!res.ok) return null;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chat-${sessionId}.${format === 'md' ? 'md' : 'json'}`;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    } catch {
      setError('Export failed');
      return false;
    }
  }, []);

  const deleteChat = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/chats/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) {
        setError('Delete failed');
        return false;
      }
      setChats(prev => prev.filter(c => c.sessionId !== sessionId));
      return true;
    } catch {
      setError('Delete failed');
      return false;
    }
  }, []);

  return { chats, loading, error, fetchChats, searchChats, restoreChat, exportChat, deleteChat };
}
