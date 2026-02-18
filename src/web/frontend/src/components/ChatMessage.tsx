import { useMemo } from 'react';
import type { ChatMessage as ChatMessageType, ContentBlock } from '../hooks/useChat';
import { ToolCall } from './ToolCall';

interface ChatMessageProps {
  message: ChatMessageType;
  onRewind?: () => void;
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

function renderBlocks(blocks: ContentBlock[]): JSX.Element[] {
  return blocks.map((block, idx) => {
    if (block.type === 'text') {
      const elements = renderContent(block.text);
      return <div key={`text-${idx}`} className="message__text-block">{elements}</div>;
    }
    if (block.type === 'info') {
      return <div key={`info-${idx}`} className="message__info-block">{block.text}</div>;
    }
    return <ToolCall key={block.tool.toolId} toolCall={block.tool} />;
  });
}

export function ChatMessage({ message, onRewind }: ChatMessageProps) {
  const rendered = useMemo(() => {
    // Use blocks if available (interleaved order), fall back to legacy
    if (message.blocks && message.blocks.length > 0) {
      return renderBlocks(message.blocks);
    }
    // Legacy fallback: text first, then tools
    const elements: JSX.Element[] = [];
    if (message.content) {
      elements.push(<div key="text">{renderContent(message.content)}</div>);
    }
    message.toolCalls.forEach(tc => {
      elements.push(<ToolCall key={tc.toolId} toolCall={tc} />);
    });
    return elements;
  }, [message.content, message.toolCalls, message.blocks]);

  return (
    <div className={`message message--${message.role}`}>
      <div className="message__label">
        {message.role === 'user' ? 'you' : 'assistant'}
        {message.role === 'user' && onRewind && (
          <button
            className="message__rewind-btn"
            onClick={onRewind}
            title="Rewind to before this message"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
          </button>
        )}
      </div>
      <div className="message__body">
        {rendered}
      </div>
    </div>
  );
}
