import { useState, useEffect } from 'react';
import type {
  AblationSummary,
  AblationDefinition,
  AblationPhase,
  AblationModel,
  AblationSettings,
  AblationProgress,
  RunSummary,
  RunDetail,
} from '../hooks/useAblations';

interface AblationPanelProps {
  open: boolean;
  onClose: () => void;
  ablations: AblationSummary[];
  loading: boolean;
  error: string | null;
  runs: RunSummary[];
  runDetail: RunDetail | null;
  runsLoading: boolean;
  onFetch: () => void;
  onFetchAblation: (name: string) => Promise<AblationDefinition | null>;
  onCreate: (ablation: {
    name: string;
    description: string;
    phases: AblationPhase[];
    models: AblationModel[];
    settings: AblationSettings;
    dryRun?: boolean;
    runs?: number;
  }) => Promise<boolean>;
  onUpdate: (name: string, updates: Record<string, unknown>) => Promise<boolean>;
  onDelete: (name: string) => Promise<boolean>;
  onFetchRuns: (name: string) => void;
  onFetchRunDetail: (name: string, timestamp: string) => void;
  onClearRuns: () => void;
  onRunAblation: (name: string) => Promise<boolean>;
  onCancelAblation: () => void;
  executing: boolean;
  progress: AblationProgress[];
}

type View = 'list' | 'create' | 'edit' | 'runs' | 'run-detail' | 'executing';

// ─── Create / Edit Form ───

function AblationForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial?: AblationDefinition;
  onSubmit: (data: {
    name: string;
    description: string;
    phases: AblationPhase[];
    models: AblationModel[];
    settings: AblationSettings;
    dryRun?: boolean;
    runs?: number;
  }) => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [maxIterations, setMaxIterations] = useState(initial?.settings.maxIterations ?? 25);
  const [mcpConfigPath, setMcpConfigPath] = useState(initial?.settings.mcpConfigPath || '');
  const [dryRun, setDryRun] = useState(initial?.dryRun || false);
  const [runs, setRuns] = useState(initial?.runs ?? 1);

  // Phases
  const [phases, setPhases] = useState<AblationPhase[]>(
    initial ? initial.phases.map(p => ({ name: p.name, commands: p.commands.length > 0 ? [...p.commands] : [''] })) : [{ name: 'default', commands: [''] }]
  );

  // Models
  const [models, setModels] = useState<AblationModel[]>(
    initial?.models || [{ provider: 'ollama', model: '' }]
  );

  const addPhase = () => setPhases([...phases, { name: '', commands: [''] }]);
  const removePhase = (i: number) => setPhases(phases.filter((_, idx) => idx !== i));
  const updatePhaseName = (i: number, n: string) => {
    const p = [...phases];
    p[i] = { ...p[i], name: n };
    setPhases(p);
  };
  const addCommand = (pi: number) => {
    const p = [...phases];
    p[pi] = { ...p[pi], commands: [...p[pi].commands, ''] };
    setPhases(p);
  };
  const updateCommand = (pi: number, ci: number, val: string) => {
    const p = [...phases];
    const cmds = [...p[pi].commands];
    cmds[ci] = val;
    p[pi] = { ...p[pi], commands: cmds };
    setPhases(p);
  };
  const removeCommand = (pi: number, ci: number) => {
    const p = [...phases];
    p[pi] = { ...p[pi], commands: p[pi].commands.filter((_, idx) => idx !== ci) };
    setPhases(p);
  };

  const addModel = () => setModels([...models, { provider: 'ollama', model: '' }]);
  const removeModel = (i: number) => setModels(models.filter((_, idx) => idx !== i));
  const updateModel = (i: number, field: 'provider' | 'model', val: string) => {
    const m = [...models];
    m[i] = { ...m[i], [field]: val };
    setModels(m);
  };

  const canSubmit = name.trim() && description.trim() &&
    phases.length > 0 && phases.every(p => p.name.trim() && p.commands.some(c => c.trim())) &&
    models.length > 0 && models.every(m => m.provider.trim() && m.model.trim());

  const handleSubmit = () => {
    if (!canSubmit) return;
    const cleanedPhases = phases.map(p => ({
      ...p,
      commands: p.commands.filter(c => c.trim()),
    }));
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      phases: cleanedPhases,
      models,
      settings: {
        maxIterations,
        ...(mcpConfigPath.trim() ? { mcpConfigPath: mcpConfigPath.trim() } : {}),
      },
      ...(dryRun ? { dryRun: true } : {}),
      ...(runs > 1 ? { runs } : {}),
    });
  };

  return (
    <div className="ablation-form">
      <div className="settings-field">
        <label className="settings-field__label">Name</label>
        <input
          className="settings-field__input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="my-study"
          disabled={!!initial}
        />
      </div>
      <div className="settings-field">
        <label className="settings-field__label">Description</label>
        <input
          className="settings-field__input"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What this ablation tests"
        />
      </div>

      <div className="ablation-form__section-label">Phases</div>
      {phases.map((phase, pi) => (
        <div key={pi} className="ablation-form__phase">
          <div className="ablation-form__phase-header">
            <input
              className="settings-field__input ablation-form__phase-name"
              value={phase.name}
              onChange={e => updatePhaseName(pi, e.target.value)}
              placeholder="Phase name"
            />
            {phases.length > 1 && (
              <button className="btn-sm btn-sm--danger" onClick={() => removePhase(pi)}>Remove</button>
            )}
          </div>
          {phase.commands.map((cmd, ci) => (
            <div key={ci} className="ablation-form__command-row">
              <input
                className="settings-field__input ablation-form__command-input"
                value={cmd}
                onChange={e => updateCommand(pi, ci, e.target.value)}
                placeholder="Command (text query, @tool:..., @shell:..., etc.)"
              />
              {phase.commands.length > 1 && (
                <button className="ablation-form__command-remove" onClick={() => removeCommand(pi, ci)} title="Remove">&times;</button>
              )}
            </div>
          ))}
          <button className="btn-sm" onClick={() => addCommand(pi)}>+ Command</button>
        </div>
      ))}
      <button className="btn-sm" onClick={addPhase}>+ Phase</button>

      <div className="ablation-form__section-label">Models</div>
      {models.map((m, i) => (
        <div key={i} className="ablation-form__model-row">
          <input
            className="settings-field__input ablation-form__model-provider"
            value={m.provider}
            onChange={e => updateModel(i, 'provider', e.target.value)}
            placeholder="Provider"
          />
          <input
            className="settings-field__input ablation-form__model-name"
            value={m.model}
            onChange={e => updateModel(i, 'model', e.target.value)}
            placeholder="Model name"
          />
          {models.length > 1 && (
            <button className="btn-sm btn-sm--danger" onClick={() => removeModel(i)}>Remove</button>
          )}
        </div>
      ))}
      <button className="btn-sm" onClick={addModel}>+ Model</button>

      <div className="ablation-form__section-label">Settings</div>
      <div className="settings-field">
        <label className="settings-field__label">Max Iterations</label>
        <input
          className="settings-field__input"
          type="number"
          value={maxIterations}
          onChange={e => setMaxIterations(Number(e.target.value))}
        />
        <span className="settings-field__hint">-1 for unlimited</span>
      </div>
      <div className="settings-field">
        <label className="settings-field__label">MCP Config Path</label>
        <input
          className="settings-field__input"
          value={mcpConfigPath}
          onChange={e => setMcpConfigPath(e.target.value)}
          placeholder="Optional custom config path"
        />
      </div>
      <div className="ablation-form__inline-row">
        <label className="settings-field__label">Repeat Runs</label>
        <input
          className="settings-field__input ablation-form__runs-input"
          type="number"
          min={1}
          value={runs}
          onChange={e => setRuns(Math.max(1, Number(e.target.value)))}
        />
      </div>
      <div className="ablation-form__inline-row">
        <label className="settings-field__label">Dry Run</label>
        <button
          className={`toggle-switch ${dryRun ? 'toggle-switch--on' : ''}`}
          onClick={() => setDryRun(!dryRun)}
        >
          <span className="toggle-switch__knob" />
        </button>
      </div>

      <div className="modal-footer">
        <button className="btn-modal btn-modal--cancel" onClick={onCancel}>Cancel</button>
        <button className="btn-modal btn-modal--save" disabled={!canSubmit} onClick={handleSubmit}>{submitLabel}</button>
      </div>
    </div>
  );
}

// ─── Run Results View ───

function RunResultsView({
  runDetail,
  loading,
  onBack,
}: {
  runDetail: RunDetail | null;
  loading: boolean;
  onBack: () => void;
}) {
  if (loading) return <div className="ablation-panel__loading">Loading results...</div>;
  if (!runDetail) return <div className="ablation-panel__empty">No results</div>;

  const statusIcon = (s: string) => {
    if (s === 'completed') return <span className="tool-call__check">&#10003;</span>;
    if (s === 'failed') return <span className="tool-call__cross">&#10007;</span>;
    if (s === 'running') return <span className="tool-call__spinner" />;
    if (s === 'aborted') return <span className="tool-call__cross">&#10007;</span>;
    return <span className="ablation-result__status-pending">&#9675;</span>;
  };

  return (
    <div className="ablation-results">
      <button className="btn-sm" onClick={onBack}>&larr; Back to runs</button>
      <div className="ablation-results__header">
        <span className="ablation-results__title">{runDetail.ablationName}</span>
        <span className="ablation-results__time">
          {new Date(runDetail.startedAt).toLocaleString()}
        </span>
      </div>
      {runDetail.totalDurationFormatted && (
        <div className="ablation-results__meta">
          Duration: {runDetail.totalDurationFormatted}
          {runDetail.totalTokens ? ` · ${runDetail.totalTokens.toLocaleString()} tokens` : ''}
        </div>
      )}
      {runDetail.resolvedArguments && Object.keys(runDetail.resolvedArguments).length > 0 && (
        <div className="ablation-results__args">
          {Object.entries(runDetail.resolvedArguments).map(([k, v]) => (
            <span key={k} className="ablation-results__arg">{k}={v}</span>
          ))}
        </div>
      )}
      <div className="ablation-results__table">
        <div className="ablation-results__table-header">
          <span className="ablation-results__col-status">Status</span>
          <span className="ablation-results__col-phase">Phase</span>
          <span className="ablation-results__col-model">Model</span>
          <span className="ablation-results__col-duration">Duration</span>
        </div>
        {runDetail.results.map((r, i) => (
          <div key={i} className={`ablation-results__row ablation-results__row--${r.status}`}>
            <span className="ablation-results__col-status">{statusIcon(r.status)}</span>
            <span className="ablation-results__col-phase">{r.phase}{r.run ? ` (run ${r.run})` : ''}</span>
            <span className="ablation-results__col-model">{r.model.model}</span>
            <span className="ablation-results__col-duration">{r.durationFormatted || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Panel ───

export function AblationPanel({
  open,
  onClose,
  ablations,
  loading,
  error,
  runs,
  runDetail,
  runsLoading,
  onFetch,
  onFetchAblation,
  onCreate,
  onUpdate,
  onDelete,
  onFetchRuns,
  onFetchRunDetail,
  onClearRuns,
  onRunAblation,
  onCancelAblation,
  executing,
  progress,
}: AblationPanelProps) {
  const [view, setView] = useState<View>('list');
  const [selectedAblation, setSelectedAblation] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [editingDefinition, setEditingDefinition] = useState<AblationDefinition | null>(null);

  useEffect(() => {
    if (open) {
      onFetch();
      setView('list');
      setSelectedAblation(null);
      onClearRuns();
    }
  }, [open, onFetch, onClearRuns]);

  if (!open) return null;

  const handleCreate = async (data: Parameters<typeof onCreate>[0]) => {
    const ok = await onCreate(data);
    if (ok) setView('list');
  };

  const handleViewRuns = (name: string) => {
    setSelectedAblation(name);
    onFetchRuns(name);
    setView('runs');
  };

  const handleViewRunDetail = (timestamp: string) => {
    if (!selectedAblation) return;
    onFetchRunDetail(selectedAblation, timestamp);
    setView('run-detail');
  };

  const handleDelete = async (name: string) => {
    await onDelete(name);
    setDeleteConfirm(null);
  };

  const handleEdit = async (name: string) => {
    const def = await onFetchAblation(name);
    if (def) {
      setEditingDefinition(def);
      setView('edit');
    }
  };

  const handleUpdate = async (data: Parameters<typeof onCreate>[0]) => {
    if (!editingDefinition) return;
    const ok = await onUpdate(editingDefinition.name, {
      description: data.description,
      phases: data.phases,
      models: data.models,
      settings: data.settings,
      dryRun: data.dryRun,
      runs: data.runs,
    });
    if (ok) {
      setEditingDefinition(null);
      setView('list');
    }
  };

  const handleRun = async (name: string) => {
    setSelectedAblation(name);
    setView('executing');
    await onRunAblation(name);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel--lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            {view === 'list' && 'Ablation Studies'}
            {view === 'create' && 'New Ablation'}
            {view === 'edit' && 'Edit Ablation'}
            {view === 'runs' && `Runs: ${selectedAblation}`}
            {view === 'run-detail' && 'Run Results'}
            {view === 'executing' && `Running: ${selectedAblation}`}
          </span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {error && <div className="settings-error">{error}</div>}

          {/* ─── List View ─── */}
          {view === 'list' && (
            <>
              <div className="ablation-panel__actions">
                <button className="btn-sm" onClick={() => setView('create')}>+ New Ablation</button>
              </div>
              {loading ? (
                <div className="ablation-panel__loading">Loading...</div>
              ) : ablations.length === 0 ? (
                <div className="ablation-panel__empty">
                  No ablation studies yet. Create one to compare model performance.
                </div>
              ) : (
                <div className="ablation-panel__list">
                  {ablations.map(a => (
                    <div key={a.name} className="ablation-card">
                      <div className="ablation-card__header">
                        <span className="ablation-card__name">{a.name}</span>
                        <div className="ablation-card__badges">
                          {a.dryRun && <span className="ablation-card__badge ablation-card__badge--dry">dry</span>}
                          <span className="ablation-card__badge">{a.phases.length} phase{a.phases.length !== 1 ? 's' : ''}</span>
                          <span className="ablation-card__badge">{a.models.length} model{a.models.length !== 1 ? 's' : ''}</span>
                          {a.totalRuns > 0 && (
                            <span className="ablation-card__badge ablation-card__badge--runs">
                              {a.totalRuns} total run{a.totalRuns !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="ablation-card__desc">{a.description}</div>
                      <div className="ablation-card__meta">
                        <span>Created: {new Date(a.created).toLocaleDateString()}</span>
                        {a.providers.length > 0 && (
                          <span>Providers: {a.providers.join(', ')}</span>
                        )}
                      </div>
                      <div className="ablation-card__footer">
                        <button className="btn-sm btn-sm--accent" onClick={() => handleRun(a.name)} disabled={executing}>Run</button>
                        <button className="btn-sm" onClick={() => handleEdit(a.name)}>Edit</button>
                        <button className="btn-sm" onClick={() => handleViewRuns(a.name)}>Runs</button>
                        <button className="btn-sm btn-sm--danger" onClick={() => setDeleteConfirm(a.name)}>Delete</button>
                      </div>
                      {deleteConfirm === a.name && (
                        <div className="ablation-card__confirm">
                          <span>Delete &quot;{a.name}&quot;?</span>
                          <button className="btn-sm btn-sm--danger" onClick={() => handleDelete(a.name)}>Confirm</button>
                          <button className="btn-sm" onClick={() => setDeleteConfirm(null)}>Cancel</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ─── Create View ─── */}
          {view === 'create' && (
            <AblationForm
              onSubmit={handleCreate}
              onCancel={() => setView('list')}
              submitLabel="Create"
            />
          )}

          {/* ─── Edit View ─── */}
          {view === 'edit' && editingDefinition && (
            <AblationForm
              initial={editingDefinition}
              onSubmit={handleUpdate}
              onCancel={() => { setEditingDefinition(null); setView('list'); }}
              submitLabel="Save"
            />
          )}

          {/* ─── Runs List View ─── */}
          {view === 'runs' && (
            <>
              <button className="btn-sm" onClick={() => { setView('list'); onClearRuns(); }}>&larr; Back to list</button>
              {runsLoading ? (
                <div className="ablation-panel__loading">Loading runs...</div>
              ) : runs.length === 0 ? (
                <div className="ablation-panel__empty">
                  No runs yet. Execute ablations from the CLI with /ablation-run.
                </div>
              ) : (
                <div className="ablation-panel__list">
                  {runs.map(r => (
                    <div key={r.timestamp} className="ablation-run-card" onClick={() => handleViewRunDetail(r.timestamp)}>
                      <div className="ablation-run-card__header">
                        <span className="ablation-run-card__time">
                          {new Date(r.startedAt).toLocaleString()}
                        </span>
                        <span className="ablation-run-card__count">
                          {r.completedCount}/{r.resultCount} completed
                          {r.failedCount > 0 && <span className="ablation-run-card__failed"> · {r.failedCount} failed</span>}
                        </span>
                      </div>
                      {r.totalDurationFormatted && (
                        <div className="ablation-run-card__meta">
                          {r.totalDurationFormatted}
                          {r.totalTokens ? ` · ${r.totalTokens.toLocaleString()} tokens` : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ─── Run Detail View ─── */}
          {view === 'run-detail' && (
            <RunResultsView
              runDetail={runDetail}
              loading={runsLoading}
              onBack={() => {
                if (selectedAblation) {
                  onFetchRuns(selectedAblation);
                  setView('runs');
                } else {
                  setView('list');
                }
              }}
            />
          )}

          {/* ─── Executing View ─── */}
          {view === 'executing' && (
            <div className="ablation-executing">
              {executing && (
                <button className="btn-sm btn-sm--danger" onClick={onCancelAblation} style={{ marginBottom: '12px' }}>
                  Cancel Run
                </button>
              )}
              {!executing && progress.length > 0 && (
                <button className="btn-sm" onClick={() => setView('list')} style={{ marginBottom: '12px' }}>
                  &larr; Back to list
                </button>
              )}
              {progress.length === 0 && executing && (
                <div className="ablation-panel__loading">Starting ablation run...</div>
              )}
              {progress.filter(p => p.status !== 'running' || p.status === 'running').length > 0 && (
                <div className="ablation-results__table">
                  <div className="ablation-results__table-header">
                    <span className="ablation-results__col-status">Status</span>
                    <span className="ablation-results__col-phase">Phase</span>
                    <span className="ablation-results__col-model">Model</span>
                    <span className="ablation-results__col-duration">Duration</span>
                  </div>
                  {progress.filter(p => p.status === 'running' || p.status === 'completed' || p.status === 'failed' || p.status === 'aborted').map((p, i) => {
                    const statusIcon = p.status === 'completed' ? <span className="tool-call__check">&#10003;</span>
                      : p.status === 'failed' || p.status === 'aborted' ? <span className="tool-call__cross">&#10007;</span>
                      : <span className="tool-call__spinner" />;
                    return (
                      <div key={i} className={`ablation-results__row ablation-results__row--${p.status}`}>
                        <span className="ablation-results__col-status">{statusIcon}</span>
                        <span className="ablation-results__col-phase">{p.phase}{p.run ? ` (run ${p.run})` : ''}</span>
                        <span className="ablation-results__col-model">{p.model.model}</span>
                        <span className="ablation-results__col-duration">{p.durationFormatted || (p.status === 'running' ? '...' : '—')}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {!executing && progress.length > 0 && (
                <div style={{ marginTop: '12px', color: 'var(--text-secondary)' }}>
                  Run complete. {progress.filter(p => p.status === 'completed').length}/{progress.filter(p => p.status !== 'running').length} scenarios completed.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
