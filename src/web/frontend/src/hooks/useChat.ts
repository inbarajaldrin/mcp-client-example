import { useState, useCallback, useRef } from 'react';

export interface ToolCallInfo {
  toolId: string;
  toolName: string;
  toolInput: Record<string, any>;
  status: 'running' | 'complete';
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallInfo[];
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (content: string, attachmentFileNames?: string[]) => {
    if (isStreaming) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      toolCalls: [],
    };

    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      toolCalls: [],
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const body: { content: string; attachmentFileNames?: string[] } = { content };
      if (attachmentFileNames && attachmentFileNames.length > 0) {
        body.attachmentFileNames = attachmentFileNames;
      }

      const response = await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last.role === 'assistant') {
            last.content = `Error: ${errorData.error}`;
          }
          return updated;
        });
        setIsStreaming(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== 'assistant') return prev;

              let updatedLast: ChatMessage;
              switch (event.type) {
                case 'text_delta':
                  updatedLast = { ...last, content: last.content + event.text };
                  break;
                case 'tool_start':
                  updatedLast = { ...last, toolCalls: [...last.toolCalls, {
                    toolId: event.toolId,
                    toolName: event.toolName,
                    toolInput: event.toolInput,
                    status: 'running',
                  }] };
                  break;
                case 'tool_complete':
                  updatedLast = { ...last, toolCalls: last.toolCalls.map(tc =>
                    tc.toolId === event.toolId
                      ? { ...tc, status: 'complete' as const, result: event.result }
                      : tc
                  ) };
                  break;
                case 'error':
                  updatedLast = { ...last, content: last.content + `\n\nError: ${event.message}` };
                  break;
                default:
                  return prev;
              }

              return [...prev.slice(0, -1), updatedLast];
            });
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last.role === 'assistant') {
            last.content += `\n\nConnection error: ${error.message}`;
          }
          return updated;
        });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [isStreaming]);

  const rewindToMessage = useCallback(async (frontendMsgIndex: number) => {
    if (isStreaming) return;
    try {
      // Get backend turns to map frontend index to backend indices
      const turnsRes = await fetch('/api/chat/turns');
      const turns: Array<{ turnNumber: number; messageIndex: number; historyIndex: number }> = await turnsRes.json();

      // Count which user turn this frontend message index corresponds to
      // Frontend messages: [user0, asst0, user1, asst1, ...] — user messages are at even indices
      let userTurnIdx = 0;
      for (let i = 0; i < frontendMsgIndex; i++) {
        if (messages[i]?.role === 'user') userTurnIdx++;
      }

      const turn = turns[userTurnIdx];
      if (!turn) return;

      const res = await fetch('/api/chat/rewind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIndex: turn.messageIndex, historyIndex: turn.historyIndex }),
      });
      if (res.ok) {
        // Truncate frontend messages to match
        setMessages(prev => prev.slice(0, frontendMsgIndex));
      }
    } catch {
      // Silently fail
    }
  }, [isStreaming, messages]);

  const clearChat = useCallback(async () => {
    await fetch('/api/chat/clear', { method: 'POST' });
    setMessages([]);
  }, []);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, isStreaming, sendMessage, clearChat, stopStreaming, rewindToMessage };
}
