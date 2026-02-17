import { useState, useEffect, useCallback, useRef } from 'react';

interface ProviderInfo {
  name: string;
  displayName: string;
}

interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
}

export function useProviderModel() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentProvider, setCurrentProvider] = useState('');
  const [currentModel, setCurrentModel] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialLoadDone = useRef(false);

  // Fetch provider list once
  useEffect(() => {
    fetch('/api/providers')
      .then(res => res.json())
      .then(setProviders)
      .catch(() => {});
  }, []);

  const fetchModels = useCallback(async (providerName: string) => {
    setLoadingModels(true);
    setError(null);
    try {
      const res = await fetch(`/api/models?provider=${encodeURIComponent(providerName)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to fetch models' }));
        setError(data.error);
        setModels([]);
      } else {
        const data = await res.json();
        setModels(data);
      }
    } catch {
      setError('Failed to fetch models');
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  // Fetch current provider/model from status, then auto-load models for that provider
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    fetch('/api/status')
      .then(res => res.json())
      .then(data => {
        setCurrentProvider(data.provider);
        setCurrentModel(data.model);
        // Auto-fetch models for the current provider so the dropdown is populated
        if (data.provider) {
          fetchModels(data.provider);
        }
      })
      .catch(() => {});
  }, [fetchModels]);

  const switchProvider = useCallback(async (provider: string, model: string) => {
    setSwitching(true);
    setError(null);
    try {
      const res = await fetch('/api/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Switch failed' }));
        setError(data.error);
        return false;
      }
      setCurrentProvider(provider);
      setCurrentModel(model);
      return true;
    } catch {
      setError('Failed to switch provider');
      return false;
    } finally {
      setSwitching(false);
    }
  }, []);

  return {
    providers, models, currentProvider, currentModel,
    loadingModels, switching, error,
    fetchModels, switchProvider,
  };
}
