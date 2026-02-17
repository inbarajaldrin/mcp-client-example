// Reference: Plan for web frontend API routes
import { Router, type Request, type Response } from 'express';
import type { MCPClient, WebStreamEvent } from '../index.js';
import { createProvider, PROVIDERS } from '../bin.js';

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

export function createApiRouter(client: MCPClient): Router {
  const router = Router();
  let isProcessing = false;

  // POST /api/chat/message — SSE streaming endpoint
  router.post('/chat/message', async (req: Request, res: Response) => {
    const { content } = req.body;
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    if (isProcessing) {
      res.status(409).json({ error: 'A message is already being processed' });
      return;
    }

    isProcessing = true;

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let cancelled = false;
    res.on('close', () => {
      cancelled = true;
    });

    const { observer, stream } = createStreamBridge<WebStreamEvent>();

    // Start processQuery in background — it pushes events via observer
    const queryPromise = client.processQuery(
      content,
      false,        // isSystemPrompt
      undefined,    // attachments
      () => cancelled,
      observer,
    ).catch((error: any) => {
      // If processQuery throws before emitting error/done, ensure the bridge closes
      observer({ type: 'error', message: error.message || String(error) });
    });

    try {
      for await (const event of stream) {
        if (cancelled) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      await queryPromise;
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
    res.json(messages.map(m => ({
      role: m.role,
      content: m.content,
      content_blocks: m.content_blocks,
      tool_calls: m.tool_calls,
      tool_results: m.tool_results,
    })));
  });

  // POST /api/chat/clear — clears conversation context
  router.post('/chat/clear', (_req: Request, res: Response) => {
    client.clearContext();
    res.json({ ok: true });
  });

  // GET /api/status — returns provider, model, token usage
  router.get('/status', (_req: Request, res: Response) => {
    try {
      const tokenUsage = client.getTokenUsage();
      res.json({
        provider: client.getProviderName(),
        model: client.getModel(),
        tokenUsage: {
          current: tokenUsage.current,
          contextWindow: tokenUsage.limit,
          percentage: tokenUsage.percentage,
        },
        isProcessing,
      });
    } catch {
      // Token counter may not be initialized yet
      res.json({
        provider: client.getProviderName(),
        model: client.getModel(),
        tokenUsage: { current: 0, contextWindow: 0, percentage: 0 },
        isProcessing,
      });
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
    });
  });

  // POST /api/settings — update preferences
  router.post('/settings', (req: Request, res: Response) => {
    const prefs = client.getPreferencesManager();
    const { mcpTimeout, maxIterations, hilEnabled } = req.body;
    try {
      if (mcpTimeout !== undefined) prefs.setMCPTimeout(mcpTimeout);
      if (maxIterations !== undefined) prefs.setMaxIterations(maxIterations);
      if (hilEnabled !== undefined) prefs.setHILEnabled(!!hilEnabled);
      res.json({
        mcpTimeout: prefs.getMCPTimeout(),
        maxIterations: prefs.getMaxIterations(),
        hilEnabled: prefs.getHILEnabled(),
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

  // POST /api/provider — switch provider and model
  router.post('/provider', async (req: Request, res: Response) => {
    const { provider: providerName, model } = req.body;
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
      await client.switchProviderAndModel(provider, model);
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

  return router;
}
