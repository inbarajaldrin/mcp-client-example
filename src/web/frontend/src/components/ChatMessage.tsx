import { useMemo } from 'react';
import type { ChatMessage as ChatMessageType } from '../hooks/useChat';
import { ToolCall } from './ToolCall';

interface ChatMessageProps {
  message: ChatMessageType;
}

/**
 * Lightweight markdown-like renderer.
 * Handles code blocks, inline code, bold, italic, links, and lists.
 */
function renderContent(text: string): JSX.Element[] {
  if (!text) return [];

  const elements: JSX.Element[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={key++}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Collect consecutive non-empty, non-code lines into a paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```')
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    const paraText = paraLines.join('\n');
    elements.push(<p key={key++}>{renderInline(paraText)}</p>);
  }

  return elements;
}

function renderInline(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  // Match: **bold**, *italic*, `code`, [text](url)
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      parts.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={key++}>{match[4]}</em>);
    } else if (match[5]) {
      parts.push(<code key={key++}>{match[6]}</code>);
    } else if (match[7]) {
      parts.push(
        <a key={key++} href={match[9]} target="_blank" rel="noopener noreferrer">
          {match[8]}
        </a>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const rendered = useMemo(() => renderContent(message.content), [message.content]);

  return (
    <div className={`message message--${message.role}`}>
      <div className="message__label">
        {message.role === 'user' ? 'you' : 'assistant'}
      </div>
      <div className="message__body">
        {rendered}
        {message.toolCalls.map(tc => (
          <ToolCall key={tc.toolId} toolCall={tc} />
        ))}
      </div>
    </div>
  );
}
