import { useState, useEffect } from 'react';

interface Status {
  provider: string;
  model: string;
  tokenUsage: {
    current: number;
    contextWindow: number;
    percentage: number;
  };
  isProcessing: boolean;
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
