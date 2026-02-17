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

  const sendMessage = useCallback(async (content: string) => {
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
      const response = await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
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

  const clearChat = useCallback(async () => {
    await fetch('/api/chat/clear', { method: 'POST' });
    setMessages([]);
  }, []);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, isStreaming, sendMessage, clearChat, stopStreaming };
}
