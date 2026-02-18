import { useState, useCallback, useRef, useEffect } from 'react';

export interface ToolCallInfo {
  toolId: string;
  toolName: string;
  toolInput: Record<string, any>;
  status: 'running' | 'complete' | 'cancelled';
  result?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'info'; text: string }
  | { type: 'tool'; tool: ToolCallInfo };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallInfo[];
  /** Ordered blocks preserving text/tool interleaving */
  blocks: ContentBlock[];
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
      blocks: [{ type: 'text', text: content }],
    };

    setMessages(prev => [...prev, userMsg]);
    setIsStreaming(true);
    let assistantCreated = false;

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
        const errorMsg: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${errorData.error}`,
          toolCalls: [],
          blocks: [{ type: 'text', text: `Error: ${errorData.error}` }],
        };
        setMessages(prev => [...prev, errorMsg]);
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
              let last = prev[prev.length - 1];
              let base = prev;

              // Lazily create assistant message on first event
              if (!last || last.role !== 'assistant') {
                last = {
                  id: `assistant-${Date.now()}`,
                  role: 'assistant',
                  content: '',
                  toolCalls: [],
                  blocks: [],
                };
                base = [...prev, last];
                assistantCreated = true;
              }

              let updatedLast: ChatMessage;
              switch (event.type) {
                case 'text_delta': {
                  const newContent = last.content + event.text;
                  // Append to last text block, or create a new one
                  const newBlocks = [...last.blocks];
                  const lastBlock = newBlocks[newBlocks.length - 1];
                  if (lastBlock && lastBlock.type === 'text') {
                    newBlocks[newBlocks.length - 1] = { type: 'text', text: lastBlock.text + event.text };
                  } else {
                    newBlocks.push({ type: 'text', text: event.text });
                  }
                  updatedLast = { ...last, content: newContent, blocks: newBlocks };
                  break;
                }
                case 'tool_start': {
                  const toolInfo: ToolCallInfo = {
                    toolId: event.toolId,
                    toolName: event.toolName,
                    toolInput: event.toolInput,
                    status: 'running',
                  };
                  updatedLast = {
                    ...last,
                    toolCalls: [...last.toolCalls, toolInfo],
                    blocks: [...last.blocks, { type: 'tool', tool: toolInfo }],
                  };
                  break;
                }
                case 'tool_complete': {
                  // Match by toolId first, fall back to first running tool with same name
                  const matchById = last.toolCalls.some(tc => tc.toolId === event.toolId);
                  // Merge toolInput from tool_complete (Anthropic sends empty input at tool_start)
                  const completeInput = event.toolInput && Object.keys(event.toolInput).length > 0
                    ? event.toolInput : undefined;

                  // If cancelled, mark tool as cancelled (shows red cross in UI)
                  if (event.cancelled) {
                    let cancelMatched = false;
                    const cancelledToolCalls = last.toolCalls.map(tc => {
                      if (cancelMatched) return tc;
                      const isMatch = matchById
                        ? tc.toolId === event.toolId
                        : tc.toolName === event.toolName && tc.status === 'running';
                      if (isMatch) {
                        cancelMatched = true;
                        return { ...tc, status: 'cancelled' as const, ...(completeInput && { toolInput: completeInput }) };
                      }
                      return tc;
                    });
                    let cancelBlockMatched = false;
                    const cancelledBlocks = last.blocks.map(b => {
                      if (cancelBlockMatched || b.type !== 'tool') return b;
                      const isMatch = matchById
                        ? b.tool.toolId === event.toolId
                        : b.tool.toolName === event.toolName && b.tool.status === 'running';
                      if (isMatch) {
                        cancelBlockMatched = true;
                        return { ...b, tool: { ...b.tool, status: 'cancelled' as const, ...(completeInput && { toolInput: completeInput }) } };
                      }
                      return b;
                    });
                    updatedLast = { ...last, toolCalls: cancelledToolCalls, blocks: [...cancelledBlocks, { type: 'info' as const, text: 'Cancelled' }] };
                    break;
                  }

                  let matched = false;
                  const updatedToolCalls = last.toolCalls.map(tc => {
                    if (matched) return tc;
                    const isMatch = matchById
                      ? tc.toolId === event.toolId
                      : tc.toolName === event.toolName && tc.status === 'running';
                    if (isMatch) {
                      matched = true;
                      return {
                        ...tc,
                        status: 'complete' as const,
                        result: event.result,
                        ...(completeInput && { toolInput: completeInput }),
                      };
                    }
                    return tc;
                  });
                  let matchedBlock = false;
                  const updatedBlocks = last.blocks.map(b => {
                    if (matchedBlock || b.type !== 'tool') return b;
                    const isMatch = matchById
                      ? b.tool.toolId === event.toolId
                      : b.tool.toolName === event.toolName && b.tool.status === 'running';
                    if (isMatch) {
                      matchedBlock = true;
                      return {
                        ...b,
                        tool: {
                          ...b.tool,
                          status: 'complete' as const,
                          result: event.result,
                          ...(completeInput && { toolInput: completeInput }),
                        },
                      };
                    }
                    return b;
                  });
                  updatedLast = { ...last, toolCalls: updatedToolCalls, blocks: updatedBlocks };
                  break;
                }
                case 'done': {
                  // Running tools with no result → cancelled (red cross)
                  // Running tools with result → complete (green check)
                  const hasCancelledTools = last.toolCalls.some(tc => tc.status === 'running' && !tc.result);
                  const doneToolCalls = last.toolCalls.map(tc => {
                    if (tc.status !== 'running') return tc;
                    return tc.result
                      ? { ...tc, status: 'complete' as const }
                      : { ...tc, status: 'cancelled' as const };
                  });
                  let doneBlocks: ContentBlock[] = last.blocks.map(b => {
                    if (b.type !== 'tool' || b.tool.status !== 'running') return b;
                    return b.tool.result
                      ? { ...b, tool: { ...b.tool, status: 'complete' as const } }
                      : { ...b, tool: { ...b.tool, status: 'cancelled' as const } };
                  });
                  if (hasCancelledTools) {
                    doneBlocks = [...doneBlocks, { type: 'info', text: 'Cancelled' }];
                  }
                  updatedLast = { ...last, toolCalls: doneToolCalls, blocks: doneBlocks };
                  break;
                }
                case 'info': {
                  const newBlocks = [...last.blocks, { type: 'info' as const, text: event.message }];
                  updatedLast = { ...last, blocks: newBlocks };
                  break;
                }
                case 'error': {
                  const errText = `\n\nError: ${event.message}`;
                  const errBlocks = [...last.blocks];
                  const lastErrBlock = errBlocks[errBlocks.length - 1];
                  if (lastErrBlock && lastErrBlock.type === 'text') {
                    errBlocks[errBlocks.length - 1] = { type: 'text', text: lastErrBlock.text + errText };
                  } else {
                    errBlocks.push({ type: 'text', text: errText });
                  }
                  updatedLast = { ...last, content: last.content + errText, blocks: errBlocks };
                  break;
                }
                default:
                  return prev;
              }

              return [...base.slice(0, -1), updatedLast];
            });
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant') {
            const errText = `\n\nConnection error: ${error.message}`;
            return [...prev.slice(0, -1), { ...last, content: last.content + errText }];
          }
          // No assistant message yet — create one with the error
          const errorMsg: ChatMessage = {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: `Connection error: ${error.message}`,
            toolCalls: [],
            blocks: [{ type: 'text', text: `Connection error: ${error.message}` }],
          };
          return [...prev, errorMsg];
        });
      }
    } finally {
      // Running tools with no result → cancelled, others → complete
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        const hasRunning = last.toolCalls.some(tc => tc.status === 'running');
        if (!hasRunning) return prev;
        const updatedToolCalls = last.toolCalls.map(tc => {
          if (tc.status !== 'running') return tc;
          return tc.result
            ? { ...tc, status: 'complete' as const }
            : { ...tc, status: 'cancelled' as const };
        });
        const updatedBlocks = last.blocks.map(b => {
          if (b.type !== 'tool' || b.tool.status !== 'running') return b;
          return b.tool.result
            ? { ...b, tool: { ...b.tool, status: 'complete' as const } }
            : { ...b, tool: { ...b.tool, status: 'cancelled' as const } };
        });
        return [...prev.slice(0, -1), { ...last, toolCalls: updatedToolCalls, blocks: updatedBlocks }];
      });
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
    // Signal cancellation to backend — don't abort the fetch/SSE stream
    // so remaining events (tool_complete, done) can still flow through
    fetch('/api/chat/cancel', { method: 'POST' }).catch(() => {});

    // Immediately show "Aborting" below the current running tool call
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      const newBlocks = [...last.blocks, { type: 'info' as const, text: 'Aborting' }];
      return [...prev.slice(0, -1), { ...last, blocks: newBlocks }];
    });
  }, []);

  // Load existing conversation from backend on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/chat/history');
        if (!res.ok) return;
        const history: Array<{
          role: string;
          content: string;
          content_blocks?: Array<{ type: string; id?: string; name?: string; input?: any; text?: string }>;
          tool_calls?: Array<{ id: string; name: string; arguments: string }>;
        }> = await res.json();

        const restored: ChatMessage[] = [];
        for (const msg of history) {
          if (msg.role === 'user') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            restored.push({
              id: `user-restored-${restored.length}`,
              role: 'user',
              content: text,
              toolCalls: [],
              blocks: text ? [{ type: 'text', text }] : [],
            });
          } else if (msg.role === 'assistant') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            const toolCalls: ToolCallInfo[] = (msg.tool_calls || []).map(tc => ({
              toolId: tc.id,
              toolName: tc.name,
              toolInput: (() => { try { return JSON.parse(tc.arguments); } catch { return {}; } })(),
              status: 'complete' as const,
            }));
            // Build blocks from content_blocks if available
            const blocks: ContentBlock[] = [];
            if (msg.content_blocks && msg.content_blocks.length > 0) {
              for (const cb of msg.content_blocks) {
                if (cb.type === 'text' && cb.text) {
                  blocks.push({ type: 'text', text: cb.text });
                } else if (cb.type === 'tool_use' && cb.name) {
                  const tc = toolCalls.find(t => t.toolId === cb.id);
                  if (tc) blocks.push({ type: 'tool', tool: tc });
                }
              }
            }
            // Fallback: text block + tool blocks
            if (blocks.length === 0) {
              if (text) blocks.push({ type: 'text', text });
              for (const tc of toolCalls) blocks.push({ type: 'tool', tool: tc });
            }
            restored.push({
              id: `assistant-restored-${restored.length}`,
              role: 'assistant',
              content: text,
              toolCalls,
              blocks,
            });
          }
          // Skip 'tool' role messages (results are shown inline)
        }
        if (restored.length > 0) {
          setMessages(restored);
        }
      } catch {
        // Ignore load errors
      }
    })();
  }, []);

  return { messages, isStreaming, sendMessage, clearChat, stopStreaming, rewindToMessage };
}
