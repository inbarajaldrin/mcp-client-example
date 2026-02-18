import { useState, useCallback } from 'react';

export interface AblationModel {
  provider: string;
  model: string;
}

export interface AblationPhaseSummary {
  name: string;
  commandCount: number;
}

export interface AblationPhase {
  name: string;
  commands: string[];
  onStart?: string[];
  onEnd?: string[];
}

export interface AblationSettings {
  maxIterations: number;
  mcpConfigPath?: string;
}

export interface AblationSummary {
  name: string;
  description: string;
  created: string;
  updated?: string;
  dryRun?: boolean;
  runs?: number;
  phases: AblationPhaseSummary[];
  models: AblationModel[];
  settings: AblationSettings;
  totalRuns: number;
  providers: string[];
}

export interface AblationDefinition {
  name: string;
  description: string;
  created: string;
  updated?: string;
  dryRun?: boolean;
  runs?: number;
  phases: AblationPhase[];
  models: AblationModel[];
  settings: AblationSettings;
}

export interface RunSummary {
  timestamp: string;
  startedAt: string;
  completedAt?: string;
  totalTokens?: number;
  totalDuration?: number;
  totalDurationFormatted?: string;
  resultCount: number;
  completedCount: number;
  failedCount: number;
}

export interface RunResultDetail {
  phase: string;
  model: AblationModel;
  run?: number;
  status: string;
  tokens?: number;
  duration?: number;
  durationFormatted?: string;
  error?: string;
}

export interface RunDetail {
  ablationName: string;
  startedAt: string;
  completedAt?: string;
  totalTokens?: number;
  totalDuration?: number;
  totalDurationFormatted?: string;
  resolvedArguments?: Record<string, string>;
  results: RunResultDetail[];
}

export interface AblationProgress {
  runNumber: number;
  totalRuns: number;
  phase: string;
  model: { provider: string; model: string };
  status: string;
  commandIndex?: number;
  totalCommands?: number;
  command?: string;
  duration?: number;
  durationFormatted?: string;
  error?: string;
}

export function useAblations() {
  const [ablations, setAblations] = useState<AblationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<AblationProgress[]>([]);

  const fetchAblations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ablations');
      const data = await res.json();
      if (res.ok) {
        setAblations(data);
      } else {
        setError(data.error || 'Failed to fetch ablations');
      }
    } catch {
      setError('Failed to fetch ablations');
    }
    setLoading(false);
  }, []);

  const createAblation = useCallback(async (ablation: {
    name: string;
    description: string;
    phases: AblationPhase[];
    models: AblationModel[];
    settings: AblationSettings;
    dryRun?: boolean;
    runs?: number;
  }): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch('/api/ablations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ablation),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create ablation');
        return false;
      }
      await fetchAblations();
      return true;
    } catch {
      setError('Failed to create ablation');
      return false;
    }
  }, [fetchAblations]);

  const updateAblation = useCallback(async (name: string, updates: Partial<AblationDefinition>): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/ablations/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to update ablation');
        return false;
      }
      await fetchAblations();
      return true;
    } catch {
      setError('Failed to update ablation');
      return false;
    }
  }, [fetchAblations]);

  const deleteAblation = useCallback(async (name: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/ablations/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to delete ablation');
        return false;
      }
      await fetchAblations();
      return true;
    } catch {
      setError('Failed to delete ablation');
      return false;
    }
  }, [fetchAblations]);

  const fetchAblation = useCallback(async (name: string): Promise<AblationDefinition | null> => {
    try {
      const res = await fetch(`/api/ablations/${encodeURIComponent(name)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, []);

  const fetchRuns = useCallback(async (name: string) => {
    setRunsLoading(true);
    setRunDetail(null);
    try {
      const res = await fetch(`/api/ablations/${encodeURIComponent(name)}/runs`);
      const data = await res.json();
      if (res.ok) {
        setRuns(data);
      }
    } catch { /* ignore */ }
    setRunsLoading(false);
  }, []);

  const fetchRunDetail = useCallback(async (name: string, timestamp: string) => {
    setRunsLoading(true);
    try {
      const res = await fetch(`/api/ablations/${encodeURIComponent(name)}/runs/${encodeURIComponent(timestamp)}`);
      const data = await res.json();
      if (res.ok) {
        setRunDetail(data);
      }
    } catch { /* ignore */ }
    setRunsLoading(false);
  }, []);

  const runAblation = useCallback(async (name: string, resolvedArguments?: Record<string, string>): Promise<boolean> => {
    setExecuting(true);
    setProgress([]);
    setError(null);
    try {
      const res = await fetch(`/api/ablations/${encodeURIComponent(name)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolvedArguments }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to start ablation run');
        setExecuting(false);
        return false;
      }
      const reader = res.body?.getReader();
      if (!reader) { setExecuting(false); return false; }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'progress' || event.type === 'result') {
              setProgress(prev => [...prev, event]);
            } else if (event.type === 'error') {
              setError(event.message);
            }
          } catch { /* ignore parse errors */ }
        }
      }
      await fetchAblations();
      setExecuting(false);
      return true;
    } catch {
      setError('Failed to run ablation');
      setExecuting(false);
      return false;
    }
  }, [fetchAblations]);

  const cancelAblation = useCallback(async () => {
    try {
      await fetch('/api/ablations/cancel', { method: 'POST' });
    } catch { /* ignore */ }
  }, []);

  return {
    ablations,
    loading,
    error,
    runs,
    runDetail,
    runsLoading,
    executing,
    progress,
    fetchAblations,
    fetchAblation,
    createAblation,
    updateAblation,
    deleteAblation,
    fetchRuns,
    fetchRunDetail,
    runAblation,
    cancelAblation,
    clearRuns: useCallback(() => { setRuns([]); setRunDetail(null); }, []),
  };
}
