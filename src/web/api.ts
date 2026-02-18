// Reference: Plan for web frontend API routes
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { tmpdir } from 'os';
import path from 'path';
import fs from 'fs';
import type { MCPClient, WebStreamEvent } from '../index.js';
import type { AttachmentInfo } from '../managers/attachment-manager.js';
import { createProvider, PROVIDERS } from '../bin.js';

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

export function createApiRouter(client: MCPClient): Router {
  const router = Router();
  let isProcessing = false;

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

    let cancelled = false;
    res.on('close', () => {
      cancelled = true;
    });

    const { observer, stream } = createStreamBridge<WebStreamEvent>();

    // Start processQuery in background — it pushes events via observer
    const queryPromise = client.processQuery(
      content,
      false,        // isSystemPrompt
      attachments,
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
        result: typeof result?.displayText === 'string' ? result.displayText : JSON.stringify(result),
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

  return router;
}
