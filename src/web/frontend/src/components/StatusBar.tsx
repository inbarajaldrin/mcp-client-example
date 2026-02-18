import { useState, useEffect, useRef, type ReactNode } from 'react';
import type { Status } from '../hooks/useStatus';

interface StatusBarProps {
  status: Status | null;
  children?: ReactNode;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n <= 0) return '$0.00';
  if (n < 0.0001) return '<$0.0001';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

export function StatusBar({ status, children }: StatusBarProps) {
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!showPopover) return;
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setShowPopover(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPopover]);

  if (!status) {
    return (
      <div className="status-bar">
        <span style={{ color: 'var(--text-muted)' }}>Connecting...</span>
      </div>
    );
  }

  const { provider, model, tokenUsage, cost, isProcessing } = status;
  const pct = Math.min(tokenUsage.percentage, 100);
  const fillClass =
    pct > 80 ? 'status-bar__token-fill--danger' :
    pct > 60 ? 'status-bar__token-fill--warning' :
    '';

  const hasCost = cost.totalCost > 0;
  const hasCallData = cost.recentCalls.length > 0;

  return (
    <div className="status-bar">
      <div className="status-bar__provider">
        <span className={`status-bar__provider-dot status-bar__provider-dot--${provider}`} />
        {provider}
      </div>

      <span className="status-bar__separator" />

      <span className="status-bar__model">{model}</span>

      <span className="status-bar__separator" />

      <div className="status-bar__tokens-group">
        <button
          ref={btnRef}
          className="status-bar__cost-btn"
          onClick={() => setShowPopover(v => !v)}
          title="Click for token and cost details"
        >
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
          {hasCost && (
            <>
              <span className="status-bar__separator" />
              <span className="status-bar__cost">{formatCost(cost.totalCost)}</span>
            </>
          )}
        </button>

        {showPopover && (
          <div className="status-bar__popover" ref={popoverRef}>
            <div className="status-bar__popover-title">Session Usage</div>

            <div className="status-bar__popover-row">
              <span className="status-bar__popover-label">Context tokens</span>
              <span className="status-bar__popover-value">
                {formatTokenCount(tokenUsage.current)} / {formatTokenCount(tokenUsage.contextWindow)}
                {' '}
                <span className={`status-bar__popover-pct status-bar__popover-pct--${tokenUsage.suggestion}`}>
                  {Math.round(pct)}%
                </span>
              </span>
            </div>

            {cost.cumulativeTokens > 0 && (
              <div className="status-bar__popover-row">
                <span className="status-bar__popover-label">Billed tokens</span>
                <span className="status-bar__popover-value">{cost.cumulativeTokens.toLocaleString()}</span>
              </div>
            )}

            <div className="status-bar__popover-row">
              <span className="status-bar__popover-label">API calls</span>
              <span className="status-bar__popover-value">{cost.callCount}</span>
            </div>

            {cost.toolUseCount > 0 && (
              <div className="status-bar__popover-row">
                <span className="status-bar__popover-label">Tool calls</span>
                <span className="status-bar__popover-value">{cost.toolUseCount}</span>
              </div>
            )}

            {hasCost && (
              <div className="status-bar__popover-row status-bar__popover-row--cost">
                <span className="status-bar__popover-label">Est. cost</span>
                <span className="status-bar__popover-value status-bar__popover-value--cost">
                  {formatCost(cost.totalCost)}
                </span>
              </div>
            )}

            {hasCallData && (
              <>
                <div className="status-bar__popover-divider" />
                <div className="status-bar__popover-subtitle">
                  Recent calls {cost.callCount > 10 ? `(last 10 of ${cost.callCount})` : ''}
                </div>
                <div className="status-bar__popover-table">
                  <div className="status-bar__popover-table-header">
                    <span>Time</span>
                    <span>In</span>
                    <span>Out</span>
                    <span>Cache</span>
                    <span>Cost</span>
                  </div>
                  {cost.recentCalls.map((call, i) => (
                    <div key={i} className="status-bar__popover-table-row">
                      <span>{formatTime(call.timestamp)}</span>
                      <span>{formatTokenCount(call.inputTokens)}</span>
                      <span>{formatTokenCount(call.outputTokens)}</span>
                      <span>
                        {call.cacheReadTokens > 0 || call.cacheCreationTokens > 0
                          ? `${formatTokenCount(call.cacheReadTokens)}r/${formatTokenCount(call.cacheCreationTokens)}w`
                          : '—'}
                      </span>
                      <span>{call.estimatedCost > 0 ? formatCost(call.estimatedCost) : '—'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
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
