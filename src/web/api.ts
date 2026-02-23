// Reference: Plan for web frontend API routes
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import fs from 'fs';
import type { MCPClient, WebStreamEvent } from '../index.js';
import type { AttachmentInfo } from '../managers/attachment-manager.js';
import { createProvider, PROVIDERS } from '../bin.js';
import { AblationManager } from '../managers/ablation-manager.js';
import { isReasoningModel, getThinkingLevelsForProvider } from '../utils/model-capabilities.js';

const upload = multer({ dest: path.join(tmpdir(), 'mcp-client-uploads') });

/**
 * Creates a push-to-pull bridge: returns an observer callback and an AsyncGenerator.
 * The observer pushes events into a queue, the generator yields them.
 * The generator finishes when a 'done' or 'error' event is observed.
 */
function createStreamBridge<T extends { type: string }>(): {
  observer: (event: T) => void;
  stream: AsyncGenerator<T>;
} {
  type QueueItem = { value: T; done: false } | { done: true };
  const queue: QueueItem[] = [];
  let resolve: ((item: QueueItem) => void) | null = null;
  let finished = false;

  function push(event: T) {
    const item: QueueItem = { value: event, done: false };
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(item);
    } else {
      queue.push(item);
    }
  }

  function finish() {
    finished = true;
    const item: QueueItem = { done: true };
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(item);
    } else {
      queue.push(item);
    }
  }

  const observer = (event: T) => {
    push(event);
    if (event.type === 'done' || event.type === 'error') {
      finish();
    }
  };

  async function* generator(): AsyncGenerator<T> {
    while (true) {
      if (queue.length > 0) {
        const item = queue.shift()!;
        if (item.done) return;
        yield item.value;
      } else if (finished) {
        return;
      } else {
        const item = await new Promise<QueueItem>((r) => { resolve = r; });
        if (item.done) return;
        yield item.value;
      }
    }
  }

  return { observer, stream: generator() };
}

/** Strip ANSI escape codes from tool output strings */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

export function createApiRouter(client: MCPClient): Router {
  const router = Router();
  let isProcessing = false;
  let cancelRequested = false;

  // Pending approval/elicitation maps — keyed by requestId, value is resolve callback
  const pendingApprovals = new Map<string, (result: 'execute' | { decision: 'reject'; message?: string }) => void>();
  const pendingElicitations = new Map<string, (result: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, any> }) => void>();

  // POST /api/chat/cancel — signal cancellation without closing the SSE stream
  // This mirrors how the CLI handles abort: set a flag, let remaining events flow through
  router.post('/chat/cancel', (_req: Request, res: Response) => {
    if (!isProcessing) {
      res.status(409).json({ error: 'No active request to cancel' });
      return;
    }
    cancelRequested = true;
    res.json({ ok: true });
  });

  // POST /api/chat/approval-response — respond to a pending tool approval request
  router.post('/chat/approval-response', (req: Request, res: Response) => {
    const { requestId, decision, message } = req.body;
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    const resolve = pendingApprovals.get(requestId);
    if (!resolve) {
      res.status(404).json({ error: 'No pending approval for this requestId' });
      return;
    }
    pendingApprovals.delete(requestId);
    resolve(decision === 'execute' ? 'execute' : { decision: 'reject', message });
    res.json({ ok: true });
  });

  // POST /api/chat/elicitation-response — respond to a pending elicitation request
  router.post('/chat/elicitation-response', (req: Request, res: Response) => {
    const { requestId, action, content } = req.body;
    if (!requestId || !action) {
      res.status(400).json({ error: 'requestId and action are required' });
      return;
    }
    const resolve = pendingElicitations.get(requestId);
    if (!resolve) {
      res.status(404).json({ error: 'No pending elicitation for this requestId' });
      return;
    }
    pendingElicitations.delete(requestId);
    resolve({ action, content });
    res.json({ ok: true });
  });

  // POST /api/chat/message — SSE streaming endpoint
  router.post('/chat/message', async (req: Request, res: Response) => {
    const { content, attachmentFileNames } = req.body;
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    if (isProcessing) {
      res.status(409).json({ error: 'A message is already being processed' });
      return;
    }

    isProcessing = true;
    cancelRequested = false;

    // Resolve attachment file names to AttachmentInfo[]
    let attachments: AttachmentInfo[] | undefined;
    if (Array.isArray(attachmentFileNames) && attachmentFileNames.length > 0) {
      const mgr = client.getAttachmentManager();
      attachments = attachmentFileNames
        .map((name: string) => mgr.getAttachmentInfo(name))
        .filter((a): a is AttachmentInfo => a !== null);
      if (attachments.length === 0) attachments = undefined;
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let connectionClosed = false;
    res.on('close', () => {
      connectionClosed = true;
      cancelRequested = true; // Also cancel if browser disconnects
      // Clean up pending approvals/elicitations on disconnect
      for (const [id, resolve] of pendingApprovals) {
        resolve({ decision: 'reject', message: 'Browser disconnected' });
      }
      pendingApprovals.clear();
      for (const [id, resolve] of pendingElicitations) {
        resolve({ action: 'cancel' });
      }
      pendingElicitations.clear();
    });

    const { observer, stream } = createStreamBridge<WebStreamEvent>();

    // Record user message to chat history
    const histMgr = client.getChatHistoryManager();
    histMgr.addUserMessage(content);

    // Wire HIL tool approval callback — emits SSE event and waits for POST response
    client.setToolApprovalCallback(async (toolName, toolInput) => {
      const requestId = crypto.randomUUID();
      return new Promise((resolve) => {
        pendingApprovals.set(requestId, resolve);
        observer({ type: 'approval_request', toolName, toolInput, requestId });
      });
    });

    // Wire web elicitation callback — emits SSE event and waits for POST response
    client.setWebElicitationCallback(async (request) => {
      const params = request.params as { message: string; requestedSchema: any; url?: string };
      if (params.url) return { action: 'decline' as const };
      const requestId = crypto.randomUUID();
      return new Promise((resolve) => {
        pendingElicitations.set(requestId, resolve);
        observer({ type: 'elicitation_request', message: params.message, requestedSchema: params.requestedSchema, requestId });
      });
    });

    // Wire IPC event listeners to forward orchestrator tool calls into SSE stream
    const ipcServer = client.getOrchestratorIPCServer();
    const ipcStartHandler = (event: { toolName: string; args: Record<string, any> }) => {
      observer({ type: 'ipc_tool_start', toolName: event.toolName, args: event.args });
    };
    const ipcEndHandler = (event: { toolName: string; args: Record<string, any>; result?: any; error?: string }) => {
      observer({ type: 'ipc_tool_end', toolName: event.toolName, args: event.args, result: event.result, error: event.error });
    };
    if (ipcServer) {
      ipcServer.on('toolCallStart', ipcStartHandler);
      ipcServer.on('toolCallEnd', ipcEndHandler);
    }

    // Start processQuery in background — it pushes events via observer
    // Cancel check uses cancelRequested (set by /cancel endpoint or connection close)
    const queryPromise = client.processQuery(
      content,
      false,        // isSystemPrompt
      attachments,
      () => cancelRequested,
      observer,
    ).catch((error: any) => {
      // If processQuery throws before emitting error/done, ensure the bridge closes
      observer({ type: 'error', message: error.message || String(error) });
    });

    try {
      for await (const event of stream) {
        if (connectionClosed) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      await queryPromise;
      // Record assistant response to chat history when cancelled.
      // Normal (non-cancelled) responses are already logged by the provider-specific
      // handler inside processQuery (Anthropic: complete handler, others: message_stop).
      // Only the cancel path skips that logging, so we catch it here.
      if (cancelRequested) {
        try {
          const messages = client.getMessages();
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant?.content) {
            histMgr.addAssistantMessage(
              typeof lastAssistant.content === 'string'
                ? lastAssistant.content
                : JSON.stringify(lastAssistant.content),
              lastAssistant.content_blocks,
              lastAssistant.thinking,
            );
          }
        } catch {
          // Ignore history recording errors
        }
      }
      // Clean up IPC listeners
      if (ipcServer) {
        ipcServer.removeListener('toolCallStart', ipcStartHandler);
        ipcServer.removeListener('toolCallEnd', ipcEndHandler);
      }
      isProcessing = false;
      res.end();
    }
  });

  // GET /api/servers — returns connected servers info
  router.get('/servers', (_req: Request, res: Response) => {
    res.json(client.getServersInfo());
  });

  // GET /api/chat/history — returns conversation messages
  router.get('/chat/history', (_req: Request, res: Response) => {
    const messages = client.getMessages();
    res.json(messages.map((m: any) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      content_blocks: m.content_blocks,
      tool_calls: m.tool_calls,
      tool_results: m.tool_results,
      tool_call_id: m.tool_call_id,
    })));
  });

  // POST /api/chat/clear — clears conversation context
  router.post('/chat/clear', (_req: Request, res: Response) => {
    // Save current session before clearing
    try {
      client.getChatHistoryManager().endSession('Chat cleared');
    } catch {
      // Ignore if no active session
    }
    client.clearContext();
    res.json({ ok: true });
  });

  // GET /api/status — returns provider, model, token usage, cost
  router.get('/status', (_req: Request, res: Response) => {
    try {
      const tokenUsage = client.getTokenUsage();
      const histMgr = client.getChatHistoryManager();
      const session = histMgr.getCurrentSession();

      const totalCost = session?.metadata?.totalCost ?? 0;
      const cumulativeTokens = session?.metadata?.cumulativeTokens ?? 0;
      const toolUseCount = session?.metadata?.toolUseCount ?? 0;
      const allCalls: any[] = session?.tokenUsagePerCallback ?? [];
      const recentCalls = allCalls.slice(-10).map((c: any) => ({
        timestamp: c.timestamp,
        inputTokens: c.inputTokens ?? 0,
        outputTokens: c.outputTokens ?? 0,
        cacheCreationTokens: c.cacheCreationTokens ?? 0,
        cacheReadTokens: c.cacheReadTokens ?? 0,
        estimatedCost: c.estimatedCost ?? 0,
      }));

      res.json({
        provider: client.getProviderName(),
        model: client.getModel(),
        tokenUsage: {
          current: tokenUsage.current,
          contextWindow: tokenUsage.limit,
          percentage: tokenUsage.percentage,
          suggestion: tokenUsage.suggestion,
        },
        cost: {
          totalCost,
          cumulativeTokens,
          toolUseCount,
          callCount: allCalls.length,
          recentCalls,
        },
        isProcessing,
        orchestrator: {
          enabled: client.isOrchestratorModeEnabled(),
          configured: client.isOrchestratorServerConfigured(),
        },
        todo: {
          enabled: client.isTodoModeEnabled(),
          configured: client.isTodoServerConfigured(),
        },
      });
    } catch {
      res.json({
        provider: client.getProviderName(),
        model: client.getModel(),
        tokenUsage: { current: 0, contextWindow: 0, percentage: 0, suggestion: 'continue' },
        cost: { totalCost: 0, cumulativeTokens: 0, toolUseCount: 0, callCount: 0, recentCalls: [] },
        isProcessing,
        orchestrator: {
          enabled: false,
          configured: client.isOrchestratorServerConfigured(),
        },
        todo: {
          enabled: false,
          configured: client.isTodoServerConfigured(),
        },
      });
    }
  });

  // ─── Orchestrator ───

  router.post('/orchestrator/enable', async (_req: Request, res: Response) => {
    try {
      if (!client.isOrchestratorServerConfigured()) {
        res.status(400).json({ error: 'mcp-tools-orchestrator server not configured' });
        return;
      }
      await client.enableOrchestratorMode();
      res.json({ ok: true, enabled: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  router.post('/orchestrator/disable', async (_req: Request, res: Response) => {
    try {
      await client.disableOrchestratorMode();
      res.json({ ok: true, enabled: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ─── Todo Mode ───

  router.post('/todo/enable', async (_req: Request, res: Response) => {
    try {
      if (!client.isTodoServerConfigured()) {
        res.status(400).json({ error: 'Todo server not configured' });
        return;
      }
      await client.enableTodoMode(
        async () => 'leave' as const,
        async () => 'leave' as const,
      );
      res.json({ ok: true, enabled: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  router.post('/todo/disable', async (_req: Request, res: Response) => {
    try {
      await client.disableTodoMode();
      res.json({ ok: true, enabled: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ─── Settings ───

  // GET /api/settings — returns current preferences
  router.get('/settings', (_req: Request, res: Response) => {
    const prefs = client.getPreferencesManager();
    res.json({
      mcpTimeout: prefs.getMCPTimeout(),
      maxIterations: prefs.getMaxIterations(),
      hilEnabled: prefs.getHILEnabled(),
      approveAll: prefs.getApproveAll(),
      thinkingEnabled: prefs.getThinkingEnabled(),
      thinkingLevel: prefs.getThinkingLevel(),
    });
  });

  // POST /api/settings — update preferences
  router.post('/settings', (req: Request, res: Response) => {
    const prefs = client.getPreferencesManager();
    const { mcpTimeout, maxIterations, hilEnabled, approveAll, thinkingEnabled, thinkingLevel } = req.body;
    try {
      if (mcpTimeout !== undefined) prefs.setMCPTimeout(mcpTimeout);
      if (maxIterations !== undefined) prefs.setMaxIterations(maxIterations);
      if (hilEnabled !== undefined) prefs.setHILEnabled(!!hilEnabled);
      if (approveAll !== undefined) prefs.setApproveAll(!!approveAll);
      if (thinkingEnabled !== undefined) prefs.setThinkingEnabled(!!thinkingEnabled);
      if (thinkingLevel !== undefined) prefs.setThinkingLevel(thinkingLevel);
      res.json({
        mcpTimeout: prefs.getMCPTimeout(),
        maxIterations: prefs.getMaxIterations(),
        hilEnabled: prefs.getHILEnabled(),
        approveAll: prefs.getApproveAll(),
        thinkingEnabled: prefs.getThinkingEnabled(),
        thinkingLevel: prefs.getThinkingLevel(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  // ─── Thinking/Reasoning ───

  // GET /api/thinking — returns current thinking config and model support info
  router.get('/thinking', (_req: Request, res: Response) => {
    const prefs = client.getPreferencesManager();
    const model = client.getModel();
    const providerName = client.getProviderName();
    const modelSupports = isReasoningModel(model, providerName);
    const levels = getThinkingLevelsForProvider(providerName);

    res.json({
      enabled: prefs.getThinkingEnabled(),
      level: prefs.getThinkingLevel(),
      modelSupportsThinking: modelSupports,
      model,
      provider: providerName,
      availableLevels: levels,
    });
  });

  // POST /api/thinking — set thinking preference
  router.post('/thinking', (req: Request, res: Response) => {
    const prefs = client.getPreferencesManager();
    const { enabled, level } = req.body;
    try {
      if (typeof enabled === 'boolean') {
        prefs.setThinkingEnabled(enabled);
      }
      if (level !== undefined) {
        prefs.setThinkingLevel(level);
      }
      res.json({
        enabled: prefs.getThinkingEnabled(),
        level: prefs.getThinkingLevel(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  // ─── Tool Management ───

  // GET /api/tools/all — returns all tools with enabled state
  router.get('/tools/all', (_req: Request, res: Response) => {
    res.json(client.getAllToolsWithState());
  });

  // POST /api/tools/toggle — toggle a single tool
  router.post('/tools/toggle', (req: Request, res: Response) => {
    const { toolName, enabled } = req.body;
    if (!toolName || typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'toolName (string) and enabled (boolean) are required' });
      return;
    }
    try {
      client.getToolManager().setToolEnabled(toolName, enabled);
      client.reapplyToolFilter();
      res.json({ ok: true, toolName, enabled });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  // POST /api/tools/server-toggle — toggle all tools for a server
  router.post('/tools/server-toggle', (req: Request, res: Response) => {
    const { serverName, enabled } = req.body;
    if (!serverName || typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'serverName (string) and enabled (boolean) are required' });
      return;
    }
    try {
      const allTools = client.getAllToolsWithState();
      const serverTools = allTools.filter(t => t.server === serverName);
      const toolMgr = client.getToolManager();
      for (const tool of serverTools) {
        toolMgr.setToolEnabled(tool.name, enabled, false);
      }
      toolMgr.saveState();
      client.reapplyToolFilter();
      res.json({ ok: true, serverName, enabled, toolCount: serverTools.length });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  // ─── Prompts ───

  // GET /api/prompts — list all prompts with enabled state
  router.get('/prompts', (_req: Request, res: Response) => {
    const allPrompts = client.listPrompts();
    const promptMgr = client.getPromptManager();
    res.json(allPrompts.map(p => ({
      name: p.prompt.name,
      server: p.server,
      description: p.prompt.description || '',
      arguments: (p.prompt.arguments || []).map(a => ({
        name: a.name,
        description: a.description || '',
        required: a.required !== false,
      })),
      enabled: promptMgr.isPromptEnabled(p.server, p.prompt.name),
    })));
  });

  // POST /api/prompts/toggle — toggle a prompt's enabled state
  router.post('/prompts/toggle', (req: Request, res: Response) => {
    const { server, name, enabled } = req.body;
    if (!server || !name || typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'server, name (strings) and enabled (boolean) are required' });
      return;
    }
    client.getPromptManager().setPromptEnabled(server, name, enabled);
    res.json({ ok: true, server, name, enabled });
  });

  // POST /api/prompts/get — resolve a prompt with arguments (preview)
  router.post('/prompts/get', async (req: Request, res: Response) => {
    const { server, name, arguments: args } = req.body;
    if (!server || !name) {
      res.status(400).json({ error: 'server and name are required' });
      return;
    }
    try {
      const result = await client.getPrompt(server, name, args);
      res.json({
        description: result.description,
        messages: result.messages.map(m => ({
          role: m.role,
          content: m.content.type === 'text' ? m.content.text
            : m.content.type === 'resource' ? `[Resource: ${m.content.resource.uri}]\n${'text' in m.content.resource ? m.content.resource.text : '[Binary]'}`
            : JSON.stringify(m.content),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/prompts/use — resolve a prompt and add its messages to the conversation
  router.post('/prompts/use', async (req: Request, res: Response) => {
    const { server, name, arguments: args } = req.body;
    if (!server || !name) {
      res.status(400).json({ error: 'server and name are required' });
      return;
    }
    try {
      const result = await client.getPrompt(server, name, args);
      const messages = client.getMessages();
      const historyMgr = client.getChatHistoryManager();
      let addedCount = 0;

      for (const msg of result.messages) {
        if (msg.role === 'user' && msg.content) {
          let text = '';
          if (msg.content.type === 'text') {
            text = msg.content.text;
          } else if (msg.content.type === 'resource') {
            text = `[Resource: ${msg.content.resource.uri}]\n${'text' in msg.content.resource ? msg.content.resource.text : '[Binary]'}`;
          } else {
            text = JSON.stringify(msg.content);
          }
          messages.push({ role: 'user', content: text });
          historyMgr.addUserMessage(text);
          addedCount++;
        }
      }

      res.json({ ok: true, addedCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ─── Provider & Model Selection ───

  // GET /api/providers — returns list of supported providers
  router.get('/providers', (_req: Request, res: Response) => {
    res.json(PROVIDERS.map(p => ({ name: p.name, displayName: p.label || p.name })));
  });

  // GET /api/models — returns models for a provider
  router.get('/models', async (req: Request, res: Response) => {
    const providerName = req.query.provider as string;
    if (!providerName) {
      res.status(400).json({ error: 'provider query param is required' });
      return;
    }
    try {
      const provider = createProvider(providerName);
      if (!provider) {
        res.status(400).json({ error: `Unknown provider: ${providerName}` });
        return;
      }
      const models = await provider.listAvailableModels();
      res.json(models);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/provider — switch provider and model (preserves context by default)
  router.post('/provider', async (req: Request, res: Response) => {
    const { provider: providerName, model, clearContext } = req.body;
    if (!providerName || !model) {
      res.status(400).json({ error: 'provider and model are required' });
      return;
    }
    try {
      const provider = createProvider(providerName);
      if (!provider) {
        res.status(400).json({ error: `Unknown provider: ${providerName}` });
        return;
      }
      if (clearContext) {
        await client.switchProviderAndModel(provider, model);
      } else {
        await client.switchModel(provider, model);
      }
      res.json({ provider: providerName, model });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ─── Chat History ───

  // GET /api/chats — list all chat sessions
  router.get('/chats', (_req: Request, res: Response) => {
    const chats = client.getChatHistoryManager().getAllChats();
    res.json(chats.map(c => ({
      sessionId: c.sessionId,
      startTime: c.startTime,
      endTime: c.endTime,
      duration: c.duration,
      messageCount: c.messageCount,
      toolUseCount: c.toolUseCount,
      model: c.model,
      servers: c.servers,
      tags: c.tags,
      name: c.name,
    })));
  });

  // GET /api/chats/search — search chats by keyword
  router.get('/chats/search', (req: Request, res: Response) => {
    const q = req.query.q as string;
    if (!q) {
      res.status(400).json({ error: 'q query param is required' });
      return;
    }
    const results = client.getChatHistoryManager().searchChats(q);
    res.json(results.map(c => ({
      sessionId: c.sessionId,
      startTime: c.startTime,
      endTime: c.endTime,
      messageCount: c.messageCount,
      model: c.model,
    })));
  });

  // GET /api/chats/:id/export — export a chat
  router.get('/chats/:id/export', (req: Request, res: Response) => {
    const format = (req.query.format as string) || 'json';
    const mgr = client.getChatHistoryManager();
    if (format === 'md') {
      const md = mgr.exportChatAsMarkdown(req.params.id);
      if (!md) { res.status(404).json({ error: 'Chat not found' }); return; }
      res.type('text/markdown').send(md);
    } else {
      const json = mgr.exportChatAsJson(req.params.id);
      if (!json) { res.status(404).json({ error: 'Chat not found' }); return; }
      res.type('application/json').send(json);
    }
  });

  // POST /api/chats/:id/restore — restore a chat session
  router.post('/chats/:id/restore', (req: Request, res: Response) => {
    const ok = client.restoreChat(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.json({ ok: true, sessionId: req.params.id });
  });

  // DELETE /api/chats/:id — delete a chat session
  router.delete('/chats/:id', (req: Request, res: Response) => {
    const ok = client.getChatHistoryManager().deleteChat(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.json({ ok: true });
  });

  // PATCH /api/chats/:id/rename — rename a chat session
  router.patch('/chats/:id/rename', (req: Request, res: Response) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name (string) is required' });
      return;
    }
    const ok = client.getChatHistoryManager().setChatName(req.params.id, name);
    if (!ok) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.json({ ok: true, name: name.trim() });
  });

  // ─── Server Refresh ───

  // POST /api/servers/refresh — refresh all server connections
  router.post('/servers/refresh', async (_req: Request, res: Response) => {
    try {
      await client.refreshServers();
      const servers = client.getServersInfo();
      res.json({ ok: true, servers });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/servers/refresh/:name — refresh a single server connection
  router.post('/servers/refresh/:name', async (req: Request, res: Response) => {
    try {
      await client.refreshServer(req.params.name);
      const servers = client.getServersInfo();
      res.json({ ok: true, servers });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ─── Conversation Rewind ───

  // GET /api/chat/turns — returns user turns for rewind UI
  router.get('/chat/turns', (_req: Request, res: Response) => {
    try {
      const turns = client.getUserTurns();
      res.json(turns.map(t => ({
        turnNumber: t.turnNumber,
        messageIndex: t.messageIndex,
        historyIndex: t.historyIndex,
        content: t.content.slice(0, 200), // Truncate for display
        timestamp: t.timestamp,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/chat/rewind — rewind conversation to a specific turn
  router.post('/chat/rewind', (req: Request, res: Response) => {
    const { messageIndex, historyIndex } = req.body;
    if (typeof messageIndex !== 'number' || typeof historyIndex !== 'number') {
      res.status(400).json({ error: 'messageIndex and historyIndex (numbers) are required' });
      return;
    }
    try {
      client.rewindToTurn({ messageIndex, historyIndex });
      const messages = client.getMessages();
      res.json({ ok: true, remainingMessages: messages.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ─── Tool Replay ───

  // GET /api/tool-replay/calls — returns replayable tool calls from current session
  router.get('/tool-replay/calls', (_req: Request, res: Response) => {
    try {
      const calls = client.getChatHistoryManager().getReplayableToolCalls();
      res.json(calls.map(c => ({
        toolName: c.toolName,
        toolInput: c.toolInput,
        toolOutput: c.toolOutput.slice(0, 500), // Truncate for listing
        timestamp: c.timestamp,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/tool-replay/execute — re-execute a tool call
  router.post('/tool-replay/execute', async (req: Request, res: Response) => {
    const { toolName, toolInput } = req.body;
    if (!toolName || typeof toolName !== 'string') {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    try {
      client.setDisableHistoryRecording(true);
      const result = await client.executeMCPTool(toolName, toolInput || {});
      client.setDisableHistoryRecording(false);
      res.json({
        ok: true,
        result: stripAnsi(typeof result?.displayText === 'string' ? result.displayText : JSON.stringify(result)),
      });
    } catch (err: any) {
      client.setDisableHistoryRecording(false);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ─── Attachments ───

  // POST /api/attachments/upload — upload a file
  router.post('/attachments/upload', upload.single('file'), async (req: Request, res: Response) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }
    try {
      const mgr = client.getAttachmentManager();
      // Rename temp file to preserve original filename (multer strips it)
      const renamedPath = path.join(path.dirname(file.path), file.originalname);
      fs.renameSync(file.path, renamedPath);
      const attachment = mgr.copyFileToAttachments(renamedPath);
      // Clean up temp file
      try { fs.unlinkSync(renamedPath); } catch {}
      if (!attachment) {
        res.status(500).json({ error: 'Failed to process attachment' });
        return;
      }
      res.json({
        ok: true,
        attachment: { fileName: attachment.fileName, ext: attachment.ext, mediaType: attachment.mediaType },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // GET /api/attachments — list all attachments
  router.get('/attachments', (_req: Request, res: Response) => {
    const mgr = client.getAttachmentManager();
    const attachments = mgr.listAttachments();
    res.json(attachments.map(a => ({ fileName: a.fileName, ext: a.ext, mediaType: a.mediaType })));
  });

  // DELETE /api/attachments/:fileName — delete an attachment
  router.delete('/attachments/:fileName', (req: Request, res: Response) => {
    const mgr = client.getAttachmentManager();
    const result = mgr.deleteAttachments([req.params.fileName]);
    if (result.deleted.length > 0) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Attachment not found' });
    }
  });

  // PATCH /api/attachments/:fileName — rename an attachment
  router.patch('/attachments/:fileName', (req: Request, res: Response) => {
    const { newName } = req.body;
    if (!newName || typeof newName !== 'string') {
      res.status(400).json({ error: 'newName is required' });
      return;
    }
    const mgr = client.getAttachmentManager();
    const ok = mgr.renameAttachment(req.params.fileName, newName);
    if (ok) {
      res.json({ ok: true, newName });
    } else {
      res.status(400).json({ error: 'Rename failed' });
    }
  });

  // ─── Ablation Studies ───

  const ablationManager = new AblationManager();

  // GET /api/ablations — list all ablation studies
  router.get('/ablations', (_req: Request, res: Response) => {
    try {
      const ablations = ablationManager.list();
      res.json(ablations.map(a => ({
        name: a.name,
        description: a.description,
        created: a.created,
        updated: a.updated,
        dryRun: a.dryRun,
        runs: a.runs,
        phases: a.phases.map(p => ({ name: p.name, commandCount: p.commands.length })),
        models: a.models,
        settings: a.settings,
        totalRuns: ablationManager.getTotalRuns(a),
        providers: ablationManager.getProviders(a),
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // GET /api/ablations/:name — get a single ablation study
  router.get('/ablations/:name', (req: Request, res: Response) => {
    try {
      const ablation = ablationManager.load(req.params.name);
      if (!ablation) {
        res.status(404).json({ error: 'Ablation not found' });
        return;
      }
      res.json(ablation);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/ablations — create a new ablation study
  router.post('/ablations', (req: Request, res: Response) => {
    const { name, description, phases, models, settings, dryRun, runs, hooks, arguments: args } = req.body;
    if (!name || !description || !phases || !models || !settings) {
      res.status(400).json({ error: 'name, description, phases, models, and settings are required' });
      return;
    }
    try {
      const ablation = ablationManager.create({
        name,
        description,
        phases,
        models,
        settings,
        dryRun,
        runs,
        hooks,
        arguments: args,
      });
      res.json({ ok: true, ablation });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  // PUT /api/ablations/:name — update an ablation study
  router.put('/ablations/:name', (req: Request, res: Response) => {
    const { description, phases, models, settings, dryRun, runs, hooks, arguments: args } = req.body;
    try {
      const ablation = ablationManager.update(req.params.name, {
        description,
        phases,
        models,
        settings,
        dryRun,
        runs,
        hooks,
        arguments: args,
      });
      if (!ablation) {
        res.status(404).json({ error: 'Ablation not found' });
        return;
      }
      res.json({ ok: true, ablation });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
  });

  // DELETE /api/ablations/:name — delete an ablation study
  router.delete('/ablations/:name', (req: Request, res: Response) => {
    try {
      const ok = ablationManager.delete(req.params.name);
      if (!ok) {
        res.status(404).json({ error: 'Ablation not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // GET /api/ablations/:name/runs — list runs for an ablation
  router.get('/ablations/:name/runs', (req: Request, res: Response) => {
    try {
      const ablation = ablationManager.load(req.params.name);
      if (!ablation) {
        res.status(404).json({ error: 'Ablation not found' });
        return;
      }
      const runs = ablationManager.listRuns(req.params.name);
      res.json(runs.map(r => ({
        timestamp: r.timestamp,
        startedAt: r.run.startedAt,
        completedAt: r.run.completedAt,
        totalTokens: r.run.totalTokens,
        totalDuration: r.run.totalDuration,
        totalDurationFormatted: r.run.totalDurationFormatted,
        resultCount: r.run.results.length,
        completedCount: r.run.results.filter(res => res.status === 'completed').length,
        failedCount: r.run.results.filter(res => res.status === 'failed').length,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // GET /api/ablations/:name/runs/:timestamp — get detailed results for a run
  router.get('/ablations/:name/runs/:timestamp', (req: Request, res: Response) => {
    try {
      const runDir = ablationManager.getRunDirectory(req.params.name, req.params.timestamp);
      const run = ablationManager.loadRunResults(runDir);
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json({
        ablationName: run.ablationName,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        totalTokens: run.totalTokens,
        totalDuration: run.totalDuration,
        totalDurationFormatted: run.totalDurationFormatted,
        resolvedArguments: run.resolvedArguments,
        results: run.results.map(r => ({
          phase: r.phase,
          model: r.model,
          run: r.run,
          status: r.status,
          tokens: r.tokens,
          duration: r.duration,
          durationFormatted: r.durationFormatted,
          error: r.error,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // ────────────────────────────────────────────────────────────────
  // POST /api/ablations/:name/run — Execute an ablation study (SSE)
  // ────────────────────────────────────────────────────────────────

  let ablationRunning = false;
  let ablationCancelRequested = false;

  router.post('/ablations/:name/run', async (req: Request, res: Response) => {
    const ablationName = req.params.name;
    const { resolvedArguments } = req.body as { resolvedArguments?: Record<string, string> };

    if (ablationRunning) {
      res.status(409).json({ error: 'An ablation is already running' });
      return;
    }
    if (isProcessing) {
      res.status(409).json({ error: 'A chat message is being processed' });
      return;
    }

    const ablation = ablationManager.load(ablationName);
    if (!ablation) {
      res.status(404).json({ error: `Ablation not found: ${ablationName}` });
      return;
    }

    ablationRunning = true;
    ablationCancelRequested = false;

    // Suspend client-side hooks during ablation runs to prevent double-triggering
    const hookManager = client.getHookManager();
    hookManager.suspend();

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let connectionClosed = false;
    res.on('close', () => {
      connectionClosed = true;
      ablationCancelRequested = true;
    });

    const send = (data: Record<string, unknown>) => {
      if (!connectionClosed) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    // Helper: format duration
    const fmtDur = (ms: number) => {
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (h > 0) return `${h}h ${m}m ${sec}s`;
      if (m > 0) return `${m}m ${sec}s`;
      return `${sec}s`;
    };

    // Helper: parse @tool: / @tool-exec: commands
    const parseToolCall = (cmd: string) => {
      let inject = true;
      let rest: string;
      if (cmd.startsWith('@tool-exec:')) { inject = false; rest = cmd.slice(11).trim(); }
      else if (cmd.startsWith('@tool:')) { inject = true; rest = cmd.slice(6).trim(); }
      else return null;
      // JSON syntax: tool_name {"arg": "value"}
      const m = rest.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*(\{.*\})?\s*$/);
      if (m) {
        try {
          return { toolName: m[1], args: JSON.parse(m[2] || '{}'), inject };
        } catch { return null; }
      }
      // Simple tool name
      const sm = rest.match(/^([a-zA-Z0-9_-]+__[a-zA-Z0-9_]+)\s*$/);
      if (sm) return { toolName: sm[1], args: {}, inject };
      return null;
    };

    // Helper: execute a single ablation command
    class AbortRunSignal extends Error { constructor() { super('@abort'); } }
    class PhaseCompleteSignal extends Error { constructor() { super('@complete-phase'); } }

    // Current phase context for hook loading
    let currentAblationDef: any = null;
    let currentPhaseName: string = '';

    const execCmd = async (command: string, dryRun: boolean, hookType: 'on-start' | 'before' | 'after' = 'before') => {
      const trimmed = command.trim();

      // @abort — signal to skip remaining phases for current model
      if (trimmed === '@abort') throw new AbortRunSignal();

      // @complete-phase — signal to advance to next phase
      if (trimmed === '@complete-phase' || trimmed.startsWith('@complete-phase:')) throw new PhaseCompleteSignal();

      // @tool: / @tool-exec:
      if (trimmed.startsWith('@tool:') || trimmed.startsWith('@tool-exec:')) {
        const parsed = parseToolCall(trimmed);
        if (!parsed) throw new Error(`Invalid tool call syntax: ${trimmed}`);
        const result = await client.executeMCPTool(parsed.toolName, parsed.args as Record<string, unknown>);
        if (parsed.inject && result.contentBlocks?.length > 0) {
          client.injectToolResult(parsed.toolName, parsed.args, result);
        }
        // Log tool execution to chat history
        client.getChatHistoryManager().addHookToolExecution(
          parsed.toolName, parsed.args as Record<string, any>, result.displayText || '',
          { type: hookType, action: parsed.inject ? 'tool-inject' : 'tool-exec' },
        );
        return;
      }

      // @shell:
      if (trimmed.startsWith('@shell:')) {
        const { execSync } = await import('child_process');
        const shellCmd = trimmed.slice(7).trim();
        if (!shellCmd) throw new Error('Empty shell command');
        execSync(shellCmd, { encoding: 'utf-8', timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'] });
        return;
      }

      // @wait:
      const waitMatch = trimmed.match(/^@wait:(\d+(?:\.\d+)?)$/);
      if (waitMatch) {
        await new Promise(r => setTimeout(r, parseFloat(waitMatch[1]) * 1000));
        return;
      }

      // Slash commands (skip for now — /add-prompt, /attachment-insert are complex)
      if (trimmed.startsWith('/')) return;

      // Plain text query → send to model (skip in dry run)
      if (dryRun) return;

      // Load ablation hooks for agent-driven phases
      const hm = client.getHookManager();
      let ablHooksLoaded = false;
      if (currentAblationDef && currentPhaseName) {
        const phaseHooks = ablationManager.getHooksForPhase(currentAblationDef, currentPhaseName);
        if (phaseHooks.length > 0) {
          hm.loadAblationHooks(phaseHooks);
          hm.setCurrentPhaseName(currentPhaseName);
          hm.resetPhaseComplete();
          ablHooksLoaded = true;
        }
      }

      try {
        client.getChatHistoryManager().addUserMessage(trimmed);
        await client.processQuery(trimmed, false, undefined, () => ablationCancelRequested || hm.isPhaseCompleteRequested() || hm.hasPendingInjection());
      } finally {
        if (ablHooksLoaded) hm.clearAblationHooks();
      }

      if (hm.isPhaseCompleteRequested()) {
        hm.resetPhaseComplete();
        throw new PhaseCompleteSignal();
      }
    };

    try {
      // Save current state
      const originalProviderName = client.getProviderName();
      const originalModel = client.getModel();
      const prefs = client.getPreferencesManager();
      const originalThinkingEnabled = prefs.getThinkingEnabled();
      const originalThinkingLevel = prefs.getThinkingLevel();
      const savedState = client.saveState();

      // Create run directory and save definition snapshot for provenance
      const { runDir } = ablationManager.createRunDirectory(ablationName);
      ablationManager.saveDefinitionSnapshot(runDir, ablation);
      ablationManager.stashOutputs(runDir);

      // Substitute arguments
      const sub = (cmds: string[]) =>
        resolvedArguments ? ablationManager.substituteArguments(cmds, resolvedArguments) : cmds;

      // Determine models and iterations
      const dryRunModel = { provider: 'none', model: 'dry-run' };
      const modelsToRun = ablation.dryRun ? [dryRunModel] : (ablation.models || []);
      const iterations = ablation.runs ?? 1;
      const hasMultiIter = iterations > 1;
      const totalRuns = ablationManager.getTotalRuns(ablation);

      interface RunResult { phase: string; model: { provider: string; model: string }; run?: number; status: string; tokens?: number; duration?: number; durationFormatted?: string; error?: string }
      const results: RunResult[] = [];
      const totalStartTime = Date.now();
      let runNumber = 0;
      let shouldBreak = false;

      // Execute: iteration > model > phase
      for (let iteration = 1; iteration <= iterations && !shouldBreak; iteration++) {

        for (const model of modelsToRun) {
          if (shouldBreak || ablationCancelRequested) break;

          const modelKey = `${model.provider}/${model.model}`;

          // Clear outputs per model (each model starts with clean outputs)
          ablationManager.clearOutputs();

          // Switch model once per model (skip in dry run)
          if (!ablation.dryRun) {
            const provider = createProvider(model.provider);
            if (!provider) throw new Error(`Unknown provider: ${model.provider}`);
            await client.switchProviderAndModel(provider, model.model);

            // Apply per-model thinking config (off by default unless specified)
            if ((model as any).thinking) {
              prefs.setThinkingEnabled(true);
              prefs.setThinkingLevel((model as any).thinking);
            } else {
              prefs.setThinkingEnabled(false);
              prefs.setThinkingLevel(undefined);
            }
          }

          let modelAborted = false;

          for (const phase of ablation.phases) {
            if (shouldBreak || ablationCancelRequested || modelAborted) break;

            // Conditional context clearing between phases (not for first phase)
            const isFirstPhase = phase === ablation.phases[0];
            if (!isFirstPhase && !ablation.dryRun) {
              if (ablation.settings.clearContextBetweenPhases !== false) {
                client.clearContext();
              }
            }

            ablationManager.createPhaseDirectory(runDir, model, phase.name, hasMultiIter ? iteration : undefined);

            runNumber++;

            const result: RunResult = { phase: phase.name, model, status: 'running' };
            if (hasMultiIter) result.run = iteration;

            send({ type: 'progress', runNumber, totalRuns, phase: phase.name, model, status: 'running', iteration: hasMultiIter ? iteration : undefined });

            const startTime = Date.now();
            const phaseCommands = sub(phase.commands);
            const phaseOnStart = phase.onStart ? sub(phase.onStart) : undefined;
            const phaseOnEnd = phase.onEnd ? sub(phase.onEnd) : undefined;

            try {
              // Set phase context for hook loading in execCmd
              currentAblationDef = ablation;
              currentPhaseName = phase.name;

              // Log phase-start event to chat history
              client.getChatHistoryManager().addPhaseEvent('phase-start', phase.name);

              // Execute onStart hooks
              if (phaseOnStart) {
                for (const cmd of phaseOnStart) {
                  if (ablationCancelRequested) break;
                  await execCmd(cmd, ablation.dryRun || false, 'on-start');
                }
              }

              // Execute commands
              let phaseCompleted = false;
              for (let i = 0; i < phaseCommands.length; i++) {
                if (ablationCancelRequested) break;
                send({ type: 'command', runNumber, totalRuns, phase: phase.name, commandIndex: i, totalCommands: phaseCommands.length, command: phaseCommands[i] });
                try {
                  await execCmd(phaseCommands[i], ablation.dryRun || false);
                } catch (cmdErr: any) {
                  if (cmdErr instanceof PhaseCompleteSignal) {
                    phaseCompleted = true;
                    break;
                  }
                  throw cmdErr; // re-throw other errors
                }
              }

              // Execute onEnd hooks (run even after @complete-phase, skip on cancel)
              if (!ablationCancelRequested && phaseOnEnd) {
                for (const cmd of phaseOnEnd) {
                  if (ablationCancelRequested) break;
                  await execCmd(cmd, ablation.dryRun || false);
                }
              }

              if (ablationCancelRequested) {
                result.status = 'aborted';
                client.getChatHistoryManager().addPhaseEvent('phase-abort', phase.name);
                shouldBreak = true;
              } else {
                result.status = 'completed';
                // Log implicit phase completion if not already logged by @complete-phase hook
                if (!phaseCompleted) {
                  client.getChatHistoryManager().addPhaseEvent('phase-abort', phase.name, { after: 'agent-stopped' });
                }
                if (!ablation.dryRun) {
                  result.tokens = client.getTokenUsage().current;
                }
              }
            } catch (err: any) {
              if (err instanceof AbortRunSignal) {
                // @abort: skip remaining phases for this model
                result.status = 'aborted';
                client.getChatHistoryManager().addPhaseEvent('phase-abort', phase.name);
                modelAborted = true;
              } else {
                result.status = 'failed';
                result.error = err.message || String(err);
                modelAborted = true;
              }
            }

            result.duration = Date.now() - startTime;
            result.durationFormatted = fmtDur(result.duration);
            results.push(result);

            send({ type: 'result', runNumber, totalRuns, ...result });

            // End chat session per phase (only when clearing context between phases)
            if (!ablation.dryRun && ablation.settings.clearContextBetweenPhases !== false) {
              try {
                client.getChatHistoryManager().endSession(`Ablation: ${phase.name} with ${model.provider}/${model.model}`);
              } catch { /* ignore */ }
            }

            // On failure: skip remaining phases for this model
            if (result.status === 'failed') {
              break;
            }

            // Capture outputs produced during this phase
            ablationManager.captureRunOutputs(runDir, phase.name, model, hasMultiIter ? iteration : undefined);
          }

          // Save cumulative chat when context persists across phases
          if (!ablation.dryRun && ablation.settings.clearContextBetweenPhases === false) {
            try {
              client.getChatHistoryManager().endSession(`Ablation: all phases with ${model.provider}/${model.model}`);
            } catch { /* ignore */ }
          }
        }

      }

      // Save run results
      const totalDuration = Date.now() - totalStartTime;
      const run = {
        ablationName,
        startedAt: new Date(totalStartTime).toISOString(),
        completedAt: new Date().toISOString(),
        ...(resolvedArguments && Object.keys(resolvedArguments).length > 0 ? { resolvedArguments } : {}),
        results,
        totalTokens: results.reduce((s, r) => s + (r.tokens || 0), 0),
        totalDuration,
        totalDurationFormatted: fmtDur(totalDuration),
      };
      ablationManager.saveRunResults(runDir, run as any);
      ablationManager.unstashOutputs(runDir);

      // Restore original state
      try {
        const originalProvider = createProvider(originalProviderName);
        await client.restoreState(savedState, originalProvider, originalModel);
        prefs.setThinkingEnabled(originalThinkingEnabled);
        prefs.setThinkingLevel(originalThinkingLevel);
      } catch { /* best effort */ }

      send({ type: 'done', summary: run });
    } catch (err: any) {
      send({ type: 'error', message: err.message || String(err) });
    } finally {
      ablationRunning = false;
      hookManager.resume();
      if (!connectionClosed) res.end();
    }
  });

  // POST /api/ablations/cancel — Cancel a running ablation
  router.post('/ablations/cancel', (_req: Request, res: Response) => {
    if (!ablationRunning) {
      res.status(404).json({ error: 'No ablation is currently running' });
      return;
    }
    ablationCancelRequested = true;
    res.json({ ok: true });
  });

  // ─── Client Hooks ───

  // GET /api/hooks — list all hooks
  router.get('/hooks', (_req: Request, res: Response) => {
    try {
      const hooks = client.getHookManager().listHooks();
      res.json(hooks);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/hooks — add a hook
  router.post('/hooks', (req: Request, res: Response) => {
    const { after, before, when, run, enabled, description } = req.body;
    if (!run || (!after && !before)) {
      res.status(400).json({ error: 'run and either after or before are required' });
      return;
    }
    try {
      const hook = client.getHookManager().addHook({
        ...(after && { after }),
        ...(before && { before }),
        ...(when && { when }),
        run,
        enabled: enabled !== false,
        ...(description && { description }),
      });
      res.json(hook);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/hooks/reload — reload hooks from disk (must be before :id routes)
  router.post('/hooks/reload', (_req: Request, res: Response) => {
    try {
      client.getHookManager().loadHooks();
      const hooks = client.getHookManager().listHooks();
      res.json({ count: hooks.length, hooks });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // DELETE /api/hooks/:id — remove a hook
  router.delete('/hooks/:id', (req: Request, res: Response) => {
    try {
      const success = client.getHookManager().removeHook(req.params.id);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/hooks/:id/enable — enable a hook
  router.post('/hooks/:id/enable', (req: Request, res: Response) => {
    try {
      const success = client.getHookManager().enableHook(req.params.id);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // POST /api/hooks/:id/disable — disable a hook
  router.post('/hooks/:id/disable', (req: Request, res: Response) => {
    try {
      const success = client.getHookManager().disableHook(req.params.id);
      res.json({ success });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return router;
}
