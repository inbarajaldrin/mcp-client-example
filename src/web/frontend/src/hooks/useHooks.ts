import { useState, useCallback } from 'react';

export interface ClientHook {
  id: string;
  after?: string;
  before?: string;
  when?: Record<string, unknown>;
  run: string;
  enabled: boolean;
  description?: string;
}

export function useHooks() {
  const [hooks, setHooks] = useState<ClientHook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/hooks');
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to fetch hooks');
        return;
      }
      setHooks(await res.json());
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  const addHook = useCallback(async (hook: Omit<ClientHook, 'id'>) => {
    setError(null);
    try {
      const res = await fetch('/api/hooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hook),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to add hook');
        return false;
      }
      await fetchHooks();
      return true;
    } catch {
      setError('Network error');
      return false;
    }
  }, [fetchHooks]);

  const removeHook = useCallback(async (id: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/hooks/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to remove hook');
        return false;
      }
      await fetchHooks();
      return true;
    } catch {
      setError('Network error');
      return false;
    }
  }, [fetchHooks]);

  const toggleHook = useCallback(async (id: string, enabled: boolean) => {
    setError(null);
    const endpoint = enabled ? 'enable' : 'disable';
    try {
      const res = await fetch(`/api/hooks/${id}/${endpoint}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || `Failed to ${endpoint} hook`);
        return false;
      }
      await fetchHooks();
      return true;
    } catch {
      setError('Network error');
      return false;
    }
  }, [fetchHooks]);

  const reloadHooks = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/hooks/reload', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to reload hooks');
        return;
      }
      await fetchHooks();
    } catch {
      setError('Network error');
    }
  }, [fetchHooks]);

  return { hooks, loading, error, fetchHooks, addHook, removeHook, toggleHook, reloadHooks };
}
