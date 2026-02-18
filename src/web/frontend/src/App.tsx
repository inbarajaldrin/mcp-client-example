import { useRef, useEffect, useState, useCallback } from 'react';
import { useChat } from './hooks/useChat';
import { useServers } from './hooks/useServers';
import { useStatus } from './hooks/useStatus';
import { useSettings } from './hooks/useSettings';
import { useProviderModel } from './hooks/useProviderModel';
import { useChatHistory } from './hooks/useChatHistory';
import { usePrompts } from './hooks/usePrompts';
import { useAttachments } from './hooks/useAttachments';
import { useToolReplay } from './hooks/useToolReplay';
import { useAblations } from './hooks/useAblations';
import { useApproval } from './hooks/useApproval';
import { ChatMessage } from './components/ChatMessage';
import { ChatInput } from './components/ChatInput';
import { ServerPanel } from './components/ServerPanel';
import { StatusBar } from './components/StatusBar';
import { SettingsModal } from './components/SettingsModal';
import { ProviderSelector } from './components/ProviderSelector';
import { ChatHistoryPanel } from './components/ChatHistoryPanel';
import { ToolReplayPanel } from './components/ToolReplayPanel';
import { AblationPanel } from './components/AblationPanel';
import { ApprovalModal } from './components/ApprovalModal';
import { HelpPanel } from './components/HelpPanel';

export function App() {
  // Approval / Elicitation
  const approval = useApproval();

  const { messages, isStreaming, sendMessage, clearChat, stopStreaming, rewindToMessage, loadHistory } = useChat({
    onApprovalRequest: approval.handleApprovalEvent,
    onElicitationRequest: approval.handleElicitationEvent,
  });
  const { servers, allTools, loading: serversLoading, toggleTool, toggleServer, refreshAll, refreshing, refreshServer, refreshingServer } = useServers();
  const status = useStatus();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Settings
  const { settings, error: settingsError, updateSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Provider/Model
  const pm = useProviderModel();

  // Chat History
  const ch = useChatHistory();
  const [historyOpen, setHistoryOpen] = useState(false);

  // Prompts
  const pr = usePrompts();

  // Attachments
  const att = useAttachments();

  // Tool Replay
  const tr = useToolReplay();
  const [toolReplayOpen, setToolReplayOpen] = useState(false);

  // Ablations
  const abl = useAblations();
  const [ablationOpen, setAblationOpen] = useState(false);

  // Help
  const [helpOpen, setHelpOpen] = useState(false);

  // Orchestrator toggle
  const handleToggleOrchestrator = useCallback(async () => {
    const endpoint = status?.orchestrator?.enabled
      ? '/api/orchestrator/disable'
      : '/api/orchestrator/enable';
    try {
      await fetch(endpoint, { method: 'POST' });
    } catch { /* ignore */ }
  }, [status?.orchestrator?.enabled]);

  // Todo mode toggle
  const handleToggleTodo = useCallback(async () => {
    const endpoint = status?.todo?.enabled
      ? '/api/todo/disable'
      : '/api/todo/enable';
    try {
      await fetch(endpoint, { method: 'POST' });
    } catch { /* ignore */ }
  }, [status?.todo?.enabled]);

  // Theme
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Theme initialization — read from localStorage or system preference
  useEffect(() => {
    const stored = localStorage.getItem('mcp-theme') as 'dark' | 'light' | null;
    const preferred = stored
      ?? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    if (preferred === 'light') {
      document.documentElement.dataset.theme = 'light';
    }
    setTheme(preferred);
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.add('theme-transitioning');
    setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 220);
    document.documentElement.dataset.theme = next === 'light' ? 'light' : '';
    localStorage.setItem('mcp-theme', next);
    setTheme(next);
  }, [theme]);

  // Rewind prefill — pre-fills chat input after rewind
  const [rewindPrefill, setRewindPrefill] = useState<string | null>(null);

  // Pending prompt context — shown above chat input after "Use"
  const [pendingContext, setPendingContext] = useState<{ name: string; text: string } | null>(null);

  // Override usePrompt to populate pending context instead of silently adding to backend
  const handleUsePrompt = useCallback(async (server: string, name: string, args?: Record<string, string>) => {
    const resolved = await pr.getPrompt(server, name, args);
    if (!resolved) return false;
    // Combine all user messages from the prompt into a single context text
    const texts = resolved.messages
      .filter(m => m.role === 'user')
      .map(m => m.content);
    if (texts.length === 0) return false;
    setPendingContext({ name, text: texts.join('\n\n') });
    return true;
  }, [pr]);

  // Wrap sendMessage to include pending context and attachments
  const handleSend = useCallback((content: string) => {
    const attachmentFileNames = att.pendingAttachments.map(a => a.fileName);
    const fileNames = attachmentFileNames.length > 0 ? attachmentFileNames : undefined;

    if (pendingContext) {
      const fullMessage = content.trim()
        ? `${pendingContext.text}\n\n${content}`
        : pendingContext.text;
      setPendingContext(null);
      att.clearPending();
      sendMessage(fullMessage, fileNames);
    } else {
      att.clearPending();
      sendMessage(content, fileNames);
    }
  }, [pendingContext, sendMessage, att]);

  // Auto-scroll to bottom on new messages or streaming updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === '/') {
        e.preventDefault();
        setHelpOpen(v => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (helpOpen)       { setHelpOpen(false);       return; }
        if (ablationOpen)   { setAblationOpen(false);   return; }
        if (toolReplayOpen) { setToolReplayOpen(false);  return; }
        if (historyOpen)    { setHistoryOpen(false);     return; }
        if (settingsOpen)   { setSettingsOpen(false);    return; }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [helpOpen, ablationOpen, toolReplayOpen, historyOpen, settingsOpen]);

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="app-header__title">
          mcp-client
        </div>
        <div className="app-header__actions">
          <button className="btn-header" onClick={() => setAblationOpen(true)} title="Ablation Studies">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3h14v1H1zM1 7h14v1H1zM1 11h14v1H1zM3 1h1v14H3zM7 1h1v14H7zM11 1h1v14h-1z"/></svg>
          </button>
          <button className="btn-header" onClick={() => setToolReplayOpen(true)} title="Tool Replay">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2v4.5h.5l.5-.5V3h9v10H7l-.5.5.5.5h5.5a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1zm4.56 7.56L4.5 7.5 6.56 5.44l-.7-.7L3.1 7.5l2.76 2.76.7-.7zM8.44 5.44l.7-.7L11.9 7.5l-2.76 2.76-.7-.7L10.5 7.5 8.44 5.44z"/></svg>
          </button>
          <button className="btn-header" onClick={() => setHistoryOpen(true)} title="Chat History">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 0 11zM8.5 4h-1v4.5l3.5 2.1.5-.82L8.5 8V4z"/></svg>
          </button>
          <button className="btn-header" onClick={() => setSettingsOpen(true)} title="Settings">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.421 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.421-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.116l.094-.318z"/></svg>
          </button>
          <button className="btn-header" onClick={() => setHelpOpen(true)} title="Help (Ctrl+/)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zm-.75-3h1.5v1.5h-1.5V10.5zm.75-6.5C6.5 4 5.5 5 5.5 6h1.5c0-.5.5-1 1-1s1 .5 1 1c0 1-1.5 .875-1.5 2.5h1.5c0-1.125 1.5-1.25 1.5-2.5 0-1.5-1-2-2-2z"/></svg>
          </button>
          <button className="btn-header" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0zm0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13zm8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5zM3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8zm10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0zm-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0zm9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707zM4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708z"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/></svg>
            )}
          </button>
          <button className="btn-clear" onClick={clearChat}>
            Clear
          </button>
        </div>
      </header>

      <ServerPanel
        servers={servers}
        allTools={allTools}
        loading={serversLoading}
        onToggleTool={toggleTool}
        onToggleServer={toggleServer}
        prompts={pr.prompts}
        promptsLoading={pr.loading}
        onTogglePrompt={pr.togglePrompt}
        onGetPrompt={pr.getPrompt}
        onUsePrompt={handleUsePrompt}
        onRefreshAll={refreshAll}
        refreshing={refreshing}
        onRefreshServer={refreshServer}
        refreshingServer={refreshingServer}
      />

      <div className="chat-area">
        <div className="chat-messages">
          {messages.length === 0 ? (
            <div className="chat-messages__empty">
              <span>Ready for input</span>
            </div>
          ) : (
            messages.map((msg, idx) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                onRewind={msg.role === 'user' && !isStreaming ? async () => {
                  const text = await rewindToMessage(idx);
                  if (text) setRewindPrefill(text);
                } : undefined}
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        <ChatInput
          onSend={handleSend}
          disabled={isStreaming}
          onStop={stopStreaming}
          isStreaming={isStreaming}
          pendingContext={pendingContext}
          onDismissContext={() => setPendingContext(null)}
          pendingAttachments={att.pendingAttachments}
          onUploadFile={att.uploadFile}
          onRemoveAttachment={att.removePending}
          uploading={att.uploading}
          prefill={rewindPrefill}
          onClearPrefill={() => setRewindPrefill(null)}
        />
      </div>

      <StatusBar status={status}>
        <ProviderSelector
          providers={pm.providers}
          models={pm.models}
          currentProvider={pm.currentProvider}
          currentModel={pm.currentModel}
          loadingModels={pm.loadingModels}
          switching={pm.switching}
          error={pm.error}
          onFetchModels={pm.fetchModels}
          onSwitch={pm.switchProvider}
        />
      </StatusBar>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={updateSettings}
        error={settingsError}
        orchestratorConfigured={status?.orchestrator?.configured}
        orchestratorEnabled={status?.orchestrator?.enabled}
        onToggleOrchestrator={handleToggleOrchestrator}
        todoConfigured={status?.todo?.configured}
        todoEnabled={status?.todo?.enabled}
        onToggleTodo={handleToggleTodo}
      />

      <ChatHistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        chats={ch.chats}
        loading={ch.loading}
        error={ch.error}
        onFetch={ch.fetchChats}
        onSearch={ch.searchChats}
        onRestore={async (sessionId: string) => {
          const ok = await ch.restoreChat(sessionId);
          if (ok) {
            await loadHistory();
            setHistoryOpen(false);
          }
          return ok;
        }}
        onExport={ch.exportChat}
        onDelete={ch.deleteChat}
        onRename={ch.renameChat}
      />

      <ToolReplayPanel
        open={toolReplayOpen}
        onClose={() => setToolReplayOpen(false)}
        calls={tr.calls}
        loading={tr.loading}
        executing={tr.executing}
        lastResult={tr.lastResult}
        onFetch={tr.fetchCalls}
        onExecute={tr.executeTool}
      />

      <AblationPanel
        open={ablationOpen}
        onClose={() => setAblationOpen(false)}
        ablations={abl.ablations}
        loading={abl.loading}
        error={abl.error}
        runs={abl.runs}
        runDetail={abl.runDetail}
        runsLoading={abl.runsLoading}
        onFetch={abl.fetchAblations}
        onFetchAblation={abl.fetchAblation}
        onCreate={abl.createAblation}
        onUpdate={abl.updateAblation}
        onDelete={abl.deleteAblation}
        onFetchRuns={abl.fetchRuns}
        onFetchRunDetail={abl.fetchRunDetail}
        onClearRuns={abl.clearRuns}
        onRunAblation={abl.runAblation}
        onCancelAblation={abl.cancelAblation}
        executing={abl.executing}
        progress={abl.progress}
      />

      <HelpPanel
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
      />

      <ApprovalModal
        pendingRequest={approval.pendingRequest}
        onApprove={(id) => approval.respondApproval(id, 'execute')}
        onReject={(id, msg) => approval.respondApproval(id, 'reject', msg)}
        onElicitationSubmit={approval.respondElicitation}
      />

    </div>
  );
}
