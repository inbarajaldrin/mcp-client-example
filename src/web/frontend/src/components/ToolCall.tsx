import { useState } from 'react';
import type { ToolCallInfo } from '../hooks/useChat';

interface ToolCallProps {
  toolCall: ToolCallInfo;
}

export function ToolCall({ toolCall }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);

  const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

  const formatJson = (data: unknown): string => {
    try {
      const raw = typeof data === 'string' ? stripAnsi(data) : data;
      if (typeof raw === 'string') {
        const parsed = JSON.parse(raw);
        return JSON.stringify(parsed, null, 2);
      }
      return JSON.stringify(raw, null, 2);
    } catch {
      return stripAnsi(String(data));
    }
  };

  // Strip server prefix for cleaner display
  const displayName = toolCall.toolName.includes('__')
    ? toolCall.toolName.split('__').slice(1).join('__')
    : toolCall.toolName;

  return (
    <div className="tool-call">
      <div className="tool-call__header" onClick={() => setExpanded(!expanded)}>
        <div className="tool-call__status">
          {toolCall.status === 'running' ? (
            <div className="tool-call__spinner" />
          ) : toolCall.status === 'cancelled' ? (
            <span className="tool-call__cross">&#10007;</span>
          ) : (
            <span className="tool-call__check">&#10003;</span>
          )}
        </div>
        <span className="tool-call__name">{displayName}</span>
        <span className={`tool-call__toggle ${expanded ? 'tool-call__toggle--open' : ''}`}>
          &#9660;
        </span>
      </div>

      <div className={`tool-call__details ${expanded ? 'tool-call__details--open' : ''}`}>
        {Object.keys(toolCall.toolInput).length > 0 && (
          <div className="tool-call__section">
            <div className="tool-call__section-label">Arguments</div>
            <pre className="tool-call__json">{formatJson(toolCall.toolInput)}</pre>
          </div>
        )}

        {toolCall.result && (
          <div className="tool-call__section">
            <div className="tool-call__section-label">Result</div>
            <pre className="tool-call__json">{formatJson(toolCall.result)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
