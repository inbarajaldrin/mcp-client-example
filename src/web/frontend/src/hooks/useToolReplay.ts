import { useState, useCallback } from 'react';

export interface ReplayableToolCall {
  toolName: string;
  toolInput: Record<string, any>;
  toolOutput: string;
  timestamp: string;
}

export function useToolReplay() {
  const [calls, setCalls] = useState<ReplayableToolCall[]>([]);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const fetchCalls = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tool-replay/calls');
      const data = await res.json();
      setCalls(data);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  const executeTool = useCallback(async (toolName: string, toolInput: Record<string, any>) => {
    setExecuting(toolName);
    setLastResult(null);
    try {
      const res = await fetch('/api/tool-replay/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName, toolInput }),
      });
      const data = await res.json();
      if (data.ok) {
        setLastResult(data.result);
      } else {
        setLastResult(`Error: ${data.error}`);
      }
    } catch (err: any) {
      setLastResult(`Error: ${err.message}`);
    } finally {
      setExecuting(null);
    }
  }, []);

  return { calls, loading, executing, lastResult, fetchCalls, executeTool };
}
