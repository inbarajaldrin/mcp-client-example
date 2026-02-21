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
  | { type: 'tool'; tool: ToolCallInfo }
  | { type: 'thinking'; text: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallInfo[];
  /** Ordered blocks preserving text/tool interleaving */
  blocks: ContentBlock[];
}

interface UseChatOptions {
  onApprovalRequest?: (toolName: string, toolInput: Record<string, any>, requestId: string) => void;
  onElicitationRequest?: (message: string, requestedSchema: any, requestId: string) => void;
}

export function useChat(options?: UseChatOptions) {
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
                case 'thinking_delta': {
                  const newBlocks = [...last.blocks];
                  const lastBlock = newBlocks[newBlocks.length - 1];
                  if (lastBlock && lastBlock.type === 'thinking') {
                    newBlocks[newBlocks.length - 1] = { type: 'thinking', text: lastBlock.text + event.text };
                  } else {
                    newBlocks.push({ type: 'thinking', text: event.text });
                  }
                  updatedLast = { ...last, blocks: newBlocks };
                  break;
                }
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
                case 'ipc_tool_start': {
                  const ipcId = `ipc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                  const ipcTool: ToolCallInfo = {
                    toolId: ipcId,
                    toolName: `⚡ ${event.toolName}`,
                    toolInput: event.args,
                    status: 'running',
                  };
                  updatedLast = {
                    ...last,
                    toolCalls: [...last.toolCalls, ipcTool],
                    blocks: [...last.blocks, { type: 'tool', tool: ipcTool }],
                  };
                  break;
                }
                case 'ipc_tool_end': {
                  const ipcName = `⚡ ${event.toolName}`;
                  let ipcMatched = false;
                  const ipcToolCalls = last.toolCalls.map(tc => {
                    if (ipcMatched) return tc;
                    if (tc.toolName === ipcName && tc.status === 'running') {
                      ipcMatched = true;
                      return {
                        ...tc,
                        status: (event.error ? 'cancelled' : 'complete') as 'complete' | 'cancelled',
                        result: event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2)),
                      };
                    }
                    return tc;
                  });
                  let ipcBlockMatched = false;
                  const ipcBlocks = last.blocks.map(b => {
                    if (ipcBlockMatched || b.type !== 'tool') return b;
                    if (b.tool.toolName === ipcName && b.tool.status === 'running') {
                      ipcBlockMatched = true;
                      return {
                        ...b,
                        tool: {
                          ...b.tool,
                          status: (event.error ? 'cancelled' : 'complete') as 'complete' | 'cancelled',
                          result: event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2)),
                        },
                      };
                    }
                    return b;
                  });
                  updatedLast = { ...last, toolCalls: ipcToolCalls, blocks: ipcBlocks };
                  break;
                }
                case 'approval_request': {
                  options?.onApprovalRequest?.(event.toolName, event.toolInput, event.requestId);
                  return prev;
                }
                case 'elicitation_request': {
                  options?.onElicitationRequest?.(event.message, event.requestedSchema, event.requestId);
                  return prev;
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

  const rewindToMessage = useCallback(async (frontendMsgIndex: number): Promise<string | null> => {
    if (isStreaming) return null;
    try {
      // Capture the message content before truncating
      const rewindedMessage = messages[frontendMsgIndex];
      const prefillText = rewindedMessage?.role === 'user' ? rewindedMessage.content : null;

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
      if (!turn) return null;

      const res = await fetch('/api/chat/rewind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIndex: turn.messageIndex, historyIndex: turn.historyIndex }),
      });
      if (res.ok) {
        // Truncate frontend messages to match
        setMessages(prev => prev.slice(0, frontendMsgIndex));
        return prefillText;
      }
    } catch {
      // Silently fail
    }
    return null;
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

  // Load conversation history from backend and rebuild messages with tool visualization
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/chat/history');
      if (!res.ok) return;
      const history: Array<{
        role: string;
        content: string;
        thinking?: string;
        content_blocks?: Array<{ type: string; id?: string; name?: string; input?: any; text?: string }>;
        tool_calls?: Array<{ id: string; name: string; arguments: string }>;
        tool_results?: Array<{ type: string; tool_use_id?: string; content?: string }>;
        tool_call_id?: string;
      }> = await res.json();

      // First pass: collect tool results from role:'tool' messages into a map
      const toolResults = new Map<string, string>();
      for (const msg of history) {
        if (msg.role === 'tool' && msg.tool_call_id && typeof msg.content === 'string') {
          toolResults.set(msg.tool_call_id, msg.content);
        }
        // Also collect from tool_results arrays on user messages (Anthropic format)
        if (msg.role === 'user' && msg.tool_results) {
          for (const tr of msg.tool_results) {
            if (tr.tool_use_id && tr.content) {
              toolResults.set(tr.tool_use_id, tr.content);
            }
          }
        }
      }

      // Second pass: build ChatMessage array
      const restored: ChatMessage[] = [];
      let msgIdx = 0;
      for (const msg of history) {
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string' ? msg.content : '';
          // Skip empty user messages that are just tool result carriers
          if (!text && (msg.tool_results && msg.tool_results.length > 0)) continue;
          if (!text) continue;
          restored.push({
            id: `restored-${msgIdx++}`,
            role: 'user',
            content: text,
            toolCalls: [],
            blocks: [{ type: 'text', text }],
          });
        } else if (msg.role === 'assistant') {
          const text = typeof msg.content === 'string' ? msg.content : '';

          // Build toolCalls from tool_calls (OpenAI format) OR content_blocks (Anthropic format)
          let toolCalls: ToolCallInfo[];
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            toolCalls = msg.tool_calls.map(tc => ({
              toolId: tc.id,
              toolName: tc.name,
              toolInput: (() => { try { return JSON.parse(tc.arguments); } catch { return {}; } })(),
              status: 'complete' as const,
              result: toolResults.get(tc.id),
            }));
          } else {
            // Extract from content_blocks (Anthropic/restored sessions)
            toolCalls = (msg.content_blocks || [])
              .filter(cb => cb.type === 'tool_use' && cb.name)
              .map(cb => ({
                toolId: cb.id || `tool-${Math.random().toString(36).slice(2)}`,
                toolName: cb.name!,
                toolInput: cb.input || {},
                status: 'complete' as const,
                result: cb.id ? toolResults.get(cb.id) : undefined,
              }));
          }

          // Build blocks from content_blocks if available
          const blocks: ContentBlock[] = [];
          if (msg.content_blocks && msg.content_blocks.length > 0) {
            for (const cb of msg.content_blocks) {
              if (cb.type === 'thinking' && (cb as any).thinking) {
                blocks.push({ type: 'thinking', text: (cb as any).thinking });
              } else if (cb.type === 'text' && cb.text) {
                blocks.push({ type: 'text', text: cb.text });
              } else if (cb.type === 'tool_use' && cb.name) {
                const tc = toolCalls.find(t => t.toolId === cb.id || t.toolName === cb.name);
                if (tc) blocks.push({ type: 'tool', tool: tc });
              }
            }
          }
          // Fallback: text block + tool blocks
          if (blocks.length === 0) {
            // Add thinking block from standalone thinking field (non-Anthropic providers)
            if (msg.thinking) {
              blocks.push({ type: 'thinking', text: msg.thinking });
            }
            if (text) blocks.push({ type: 'text', text });
            for (const tc of toolCalls) blocks.push({ type: 'tool', tool: tc });
          }
          restored.push({
            id: `restored-${msgIdx++}`,
            role: 'assistant',
            content: text,
            toolCalls,
            blocks,
          });
        }
        // Skip 'tool' role messages — their results are attached to the matching tool_use blocks above
      }
      setMessages(restored);
    } catch {
      // Ignore load errors
    }
  }, []);

  // Load existing conversation from backend on mount
  useEffect(() => { loadHistory(); }, [loadHistory]);

  return { messages, isStreaming, sendMessage, clearChat, stopStreaming, rewindToMessage, loadHistory };
}
