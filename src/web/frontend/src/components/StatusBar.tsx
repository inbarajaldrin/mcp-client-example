import type { ReactNode } from 'react';

interface StatusBarProps {
  status: {
    provider: string;
    model: string;
    tokenUsage: {
      current: number;
      contextWindow: number;
      percentage: number;
    };
    isProcessing: boolean;
  } | null;
  children?: ReactNode;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function StatusBar({ status, children }: StatusBarProps) {
  if (!status) {
    return (
      <div className="status-bar">
        <span style={{ color: 'var(--text-muted)' }}>Connecting...</span>
      </div>
    );
  }

  const { provider, model, tokenUsage, isProcessing } = status;
  const pct = Math.min(tokenUsage.percentage, 100);
  const fillClass =
    pct > 80 ? 'status-bar__token-fill--danger' :
    pct > 60 ? 'status-bar__token-fill--warning' :
    '';

  return (
    <div className="status-bar">
      <div className="status-bar__provider">
        <span className={`status-bar__provider-dot status-bar__provider-dot--${provider}`} />
        {provider}
      </div>

      <span className="status-bar__separator" />

      <span className="status-bar__model">{model}</span>

      <span className="status-bar__separator" />

      <div className="status-bar__tokens">
        <div className="status-bar__token-bar">
          <div
            className={`status-bar__token-fill ${fillClass}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span>
          {formatTokenCount(tokenUsage.current)} / {formatTokenCount(tokenUsage.contextWindow)}
        </span>
      </div>

      <span className="status-bar__separator" />

      {children}

      {isProcessing ? (
        <div className="status-bar__processing">
          <span className="status-bar__processing-dot" />
          processing
        </div>
      ) : (
        <span className="status-bar__idle">ready</span>
      )}
    </div>
  );
}
