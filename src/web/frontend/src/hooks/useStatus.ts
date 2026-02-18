import { useState, useEffect } from 'react';

export interface TokenCallEntry {
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
}

export interface Status {
  provider: string;
  model: string;
  tokenUsage: {
    current: number;
    contextWindow: number;
    percentage: number;
    suggestion: 'continue' | 'warn' | 'break';
  };
  cost: {
    totalCost: number;
    cumulativeTokens: number;
    toolUseCount: number;
    callCount: number;
    recentCalls: TokenCallEntry[];
  };
  isProcessing: boolean;
  orchestrator: {
    enabled: boolean;
    configured: boolean;
  };
  todo: {
    enabled: boolean;
    configured: boolean;
  };
}

export function useStatus() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    const fetchStatus = () => {
      fetch('/api/status')
        .then(res => res.json())
        .then(setStatus)
        .catch(() => {});
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  return status;
}
