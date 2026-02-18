import { useRef, useEffect, useState, useCallback } from 'react';
import { useChat } from './hooks/useChat';
import { useServers } from './hooks/useServers';
import { useStatus } from './hooks/useStatus';
import { useSettings } from './hooks/useSettings';
import { useProviderModel } from './hooks/useProviderModel';
import { useChatHistory } from './hooks/useChatHistory';
import { usePrompts } from './hooks/usePrompts';
import { useAttachments } from './hooks/useAttachments';
import { ChatMessage } from './components/ChatMessage';
import { ChatInput } from './components/ChatInput';
import { ServerPanel } from './components/ServerPanel';
import { StatusBar } from './components/StatusBar';
import { SettingsModal } from './components/SettingsModal';
import { ProviderSelector } from './components/ProviderSelector';
import { ChatHistoryPanel } from './components/ChatHistoryPanel';

export function App() {
  const { messages, isStreaming, sendMessage, clearChat, stopStreaming } = useChat();
  const { servers, allTools, loading: serversLoading, toggleTool, toggleServer } = useServers();
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

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="app-header__title">
          mcp-client
        </div>
        <div className="app-header__actions">
          <button className="btn-header" onClick={() => setHistoryOpen(true)} title="Chat History">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 0 11zM8.5 4h-1v4.5l3.5 2.1.5-.82L8.5 8V4z"/></svg>
          </button>
          <button className="btn-header" onClick={() => setSettingsOpen(true)} title="Settings">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.421 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.421-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.116l.094-.318z"/></svg>
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
      />

      <div className="chat-area">
        <div className="chat-messages">
          {messages.length === 0 ? (
            <div className="chat-messages__empty">
              <span>Ready for input</span>
            </div>
          ) : (
            messages.map(msg => <ChatMessage key={msg.id} message={msg} />)
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
      />

      <ChatHistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        chats={ch.chats}
        loading={ch.loading}
        error={ch.error}
        onFetch={ch.fetchChats}
        onSearch={ch.searchChats}
        onRestore={ch.restoreChat}
        onExport={ch.exportChat}
        onDelete={ch.deleteChat}
      />

    </div>
  );
}
