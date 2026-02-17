import { useState, useEffect } from 'react';

interface ProviderInfo {
  name: string;
  displayName: string;
}

interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

interface ProviderSelectorProps {
  providers: ProviderInfo[];
  models: ModelInfo[];
  currentProvider: string;
  currentModel: string;
  loadingModels: boolean;
  switching: boolean;
  error: string | null;
  onFetchModels: (provider: string) => void;
  onSwitch: (provider: string, model: string) => Promise<boolean>;
}

export function ProviderSelector({
  providers, models, currentProvider, currentModel,
  loadingModels, switching, error,
  onFetchModels, onSwitch,
}: ProviderSelectorProps) {
  const [selectedProvider, setSelectedProvider] = useState(currentProvider);
  const [selectedModel, setSelectedModel] = useState(currentModel);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    setSelectedProvider(currentProvider);
    setSelectedModel(currentModel);
  }, [currentProvider, currentModel]);

  const handleProviderChange = (name: string) => {
    setSelectedProvider(name);
    setSelectedModel('');
    onFetchModels(name);
  };

  const handleApply = () => {
    if (selectedProvider !== currentProvider || selectedModel !== currentModel) {
      setShowConfirm(true);
    }
  };

  const handleConfirm = async () => {
    setShowConfirm(false);
    await onSwitch(selectedProvider, selectedModel);
  };

  const isDirty = selectedProvider !== currentProvider || selectedModel !== currentModel;

  return (
    <div className="provider-selector">
      <select
        className="provider-selector__select"
        value={selectedProvider}
        onChange={e => handleProviderChange(e.target.value)}
        disabled={switching}
      >
        <option value="" disabled>Provider</option>
        {providers.map(p => (
          <option key={p.name} value={p.name}>{p.displayName}</option>
        ))}
      </select>

      <select
        className="provider-selector__select provider-selector__select--model"
        value={selectedModel}
        onChange={e => setSelectedModel(e.target.value)}
        disabled={switching || loadingModels || models.length === 0}
      >
        <option value="" disabled>
          {loadingModels ? 'Loading...' : 'Model'}
        </option>
        {models.map(m => (
          <option key={m.id} value={m.id}>{m.name || m.id}</option>
        ))}
      </select>

      {isDirty && selectedModel && (
        <button
          className="provider-selector__apply"
          onClick={handleApply}
          disabled={switching}
        >
          {switching ? '...' : 'Apply'}
        </button>
      )}

      {error && <span className="provider-selector__error">{error}</span>}

      {showConfirm && (
        <div className="modal-overlay" onClick={() => setShowConfirm(false)}>
          <div className="modal-panel modal-panel--sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Switch Provider</span>
              <button className="modal-close" onClick={() => setShowConfirm(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                Switching to <strong>{selectedProvider}/{selectedModel}</strong> will clear the current conversation context. Continue?
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn-modal btn-modal--cancel" onClick={() => setShowConfirm(false)}>Cancel</button>
              <button className="btn-modal btn-modal--save" onClick={handleConfirm}>Switch</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
