import { useState, useRef, useCallback, useEffect } from 'react';

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled: boolean;
  onStop: () => void;
  isStreaming: boolean;
  pendingContext?: { name: string; text: string } | null;
  onDismissContext?: () => void;
}

export function ChatInput({ onSend, disabled, onStop, isStreaming, pendingContext, onDismissContext }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // Focus textarea when pending context is set
  useEffect(() => {
    if (pendingContext) {
      textareaRef.current?.focus();
    }
  }, [pendingContext]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    // Allow send with empty input if there's pending context
    if (!trimmed && !pendingContext) return;
    if (disabled) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend, pendingContext]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="chat-input">
      {pendingContext && (
        <div className="chat-input__context">
          <div className="chat-input__context-header">
            <span className="chat-input__context-label">Prompt: {pendingContext.name}</span>
            <button className="chat-input__context-dismiss" onClick={onDismissContext}>&times;</button>
          </div>
          <div className="chat-input__context-text">
            {pendingContext.text}
          </div>
          <div className="chat-input__context-hint">
            Press Enter to send, or type additional instructions below
          </div>
        </div>
      )}
      <div className="chat-input__wrapper">
        <textarea
          ref={textareaRef}
          className="chat-input__textarea"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={pendingContext ? 'Add instructions (optional), then press Enter...' : 'Send a message...'}
          disabled={disabled}
          rows={1}
        />
        {isStreaming ? (
          <button className="chat-input__btn chat-input__btn--stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            className="chat-input__btn chat-input__btn--send"
            onClick={handleSend}
            disabled={disabled || (!value.trim() && !pendingContext)}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
