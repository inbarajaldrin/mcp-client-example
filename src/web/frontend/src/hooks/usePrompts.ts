import { useState, useEffect, useCallback } from 'react';

export interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptInfo {
  name: string;
  server: string;
  description: string;
  arguments: PromptArg[];
  enabled: boolean;
}

export interface ResolvedPrompt {
  description?: string;
  messages: Array<{ role: string; content: string }>;
}

export function usePrompts() {
  const [prompts, setPrompts] = useState<PromptInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPrompts = useCallback(() => {
    setLoading(true);
    fetch('/api/prompts')
      .then(res => res.json())
      .then(data => {
        setPrompts(data);
        setLoading(false);
        setError(null);
      })
      .catch(() => {
        setLoading(false);
        setError('Failed to load prompts');
      });
  }, []);

  useEffect(() => {
    fetchPrompts();
  }, [fetchPrompts]);

  const togglePrompt = useCallback(async (server: string, name: string, enabled: boolean) => {
    await fetch('/api/prompts/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, name, enabled }),
    });
    fetchPrompts();
  }, [fetchPrompts]);

  const getPrompt = useCallback(async (server: string, name: string, args?: Record<string, string>): Promise<ResolvedPrompt | null> => {
    try {
      const res = await fetch('/api/prompts/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server, name, arguments: args }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed' }));
        setError(data.error);
        return null;
      }
      return await res.json();
    } catch {
      setError('Failed to get prompt');
      return null;
    }
  }, []);

  const usePrompt = useCallback(async (server: string, name: string, args?: Record<string, string>) => {
    try {
      const res = await fetch('/api/prompts/use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server, name, arguments: args }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed' }));
        setError(data.error);
        return false;
      }
      return true;
    } catch {
      setError('Failed to use prompt');
      return false;
    }
  }, []);

  return { prompts, loading, error, fetchPrompts, togglePrompt, getPrompt, usePrompt };
}
