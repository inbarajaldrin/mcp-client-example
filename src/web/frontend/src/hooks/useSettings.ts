import { useState, useEffect, useCallback } from 'react';

export interface Settings {
  mcpTimeout: number;
  maxIterations: number;
  hilEnabled: boolean;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        setSettings(data);
        setLoading(false);
        setError(null);
      })
      .catch(() => {
        setLoading(false);
        setError('Failed to load settings');
      });
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(async (partial: Partial<Settings>) => {
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Update failed' }));
        setError(data.error);
        return false;
      }
      const data = await res.json();
      setSettings(data);
      return true;
    } catch {
      setError('Failed to update settings');
      return false;
    }
  }, []);

  return { settings, loading, error, updateSettings, refetch: fetchSettings };
}
