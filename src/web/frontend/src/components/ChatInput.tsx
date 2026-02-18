import { useState, useRef, useCallback, useEffect } from 'react';
import type { Attachment } from '../hooks/useAttachments';

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled: boolean;
  onStop: () => void;
  isStreaming: boolean;
  pendingContext?: { name: string; text: string } | null;
  onDismissContext?: () => void;
  pendingAttachments: Attachment[];
  onUploadFile: (file: File) => void;
  onRemoveAttachment: (fileName: string) => void;
  uploading: boolean;
}

export function ChatInput({
  onSend,
  disabled,
  onStop,
  isStreaming,
  pendingContext,
  onDismissContext,
  pendingAttachments,
  onUploadFile,
  onRemoveAttachment,
  uploading,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  useEffect(() => {
    if (pendingContext) {
      textareaRef.current?.focus();
    }
  }, [pendingContext]);

  const hasPending = pendingAttachments.length > 0;

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && !pendingContext && !hasPending) return;
    if (disabled) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend, pendingContext, hasPending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      Array.from(files).forEach(f => onUploadFile(f));
      e.target.value = '';
    },
    [onUploadFile],
  );

  const handlePaperclip = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      const files = e.dataTransfer.files;
      if (!files) return;
      Array.from(files).forEach(f => onUploadFile(f));
    },
    [onUploadFile],
  );

  const isSendDisabled = disabled || (!value.trim() && !pendingContext && !hasPending);

  return (
    <div
      className="chat-input"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="chat-input__drop-overlay">
          <div className="chat-input__drop-label">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Drop files to attach
          </div>
        </div>
      )}

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

      {hasPending && (
        <div className="chat-input__attachments">
          {pendingAttachments.map(att => {
            const isImage = att.mediaType.startsWith('image/');
            return isImage && att.previewUrl ? (
              <div key={att.fileName} className="chat-input__attachment-card chat-input__attachment-card--image">
                <img
                  src={att.previewUrl}
                  alt={att.fileName}
                  className="chat-input__attachment-thumb"
                />
                <span className="chat-input__attachment-name" title={att.fileName}>
                  {att.fileName}
                </span>
                <button
                  className="chat-input__attachment-remove"
                  onClick={() => onRemoveAttachment(att.fileName)}
                  title="Remove attachment"
                >
                  &times;
                </button>
              </div>
            ) : (
              <div key={att.fileName} className="chat-input__attachment-card">
                <span className="chat-input__attachment-ext">{att.ext.replace('.', '').toUpperCase()}</span>
                <span className="chat-input__attachment-name" title={att.fileName}>
                  {att.fileName}
                </span>
                <button
                  className="chat-input__attachment-remove"
                  onClick={() => onRemoveAttachment(att.fileName)}
                  title="Remove attachment"
                >
                  &times;
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="chat-input__wrapper">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="chat-input__file-input"
          onChange={handleFileChange}
        />
        <button
          className={`chat-input__btn chat-input__btn--attach${uploading ? ' chat-input__btn--attach-loading' : ''}`}
          onClick={handlePaperclip}
          disabled={disabled}
          title="Attach file"
          type="button"
        >
          {uploading ? (
            <span className="chat-input__attach-spinner" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          )}
        </button>
        <textarea
          ref={textareaRef}
          className="chat-input__textarea"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            pendingContext
              ? 'Add instructions (optional), then press Enter...'
              : hasPending
              ? 'Add a message (optional), then press Enter...'
              : 'Send a message...'
          }
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
            disabled={isSendDisabled}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
