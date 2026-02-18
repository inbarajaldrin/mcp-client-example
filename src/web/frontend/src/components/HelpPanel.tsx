interface HelpPanelProps {
  open: boolean;
  onClose: () => void;
}

interface HelpRow {
  action: string;
  how: string;
  kbd?: string;
}

interface HelpSection {
  title: string;
  rows: HelpRow[];
}

const HELP_SECTIONS: HelpSection[] = [
  {
    title: 'Keyboard Shortcuts',
    rows: [
      { action: 'Send message',       how: 'While focused on chat input',  kbd: 'Enter' },
      { action: 'New line in input',   how: 'While focused on chat input',  kbd: 'Shift+Enter' },
      { action: 'Open Help panel',     how: 'Global shortcut',              kbd: 'Ctrl+/' },
      { action: 'Close open panel',    how: 'Global shortcut',              kbd: 'Escape' },
    ],
  },
  {
    title: 'Chat Input',
    rows: [
      { action: 'Send a message',      how: 'Type text and press Enter' },
      { action: 'Attach a file',       how: 'Click the paperclip icon left of the text field' },
      { action: 'Attach via drag-drop', how: 'Drag any file onto the chat input area' },
      { action: 'Stop a response',     how: 'Click the Stop button (appears while streaming)' },
      { action: 'Rewind conversation', how: 'Hover over any user message and click the rewind icon' },
      { action: 'Use a prompt',        how: 'Click Use on a sidebar prompt — text loads as context above input' },
    ],
  },
  {
    title: 'Header Buttons',
    rows: [
      { action: 'Ablation Studies',    how: 'Grid icon — compare model performance across phases' },
      { action: 'Tool Replay',         how: 'Code icon — re-execute tool calls from the current session' },
      { action: 'Chat History',        how: 'Clock icon — browse, restore, rename, export past sessions' },
      { action: 'Settings',            how: 'Gear icon — set timeout, max iterations, HIL mode' },
      { action: 'Help',                how: 'Question mark icon — this panel' },
      { action: 'Clear chat',          how: 'Text button — saves session and clears the current conversation' },
    ],
  },
  {
    title: 'Left Sidebar (Server Panel)',
    rows: [
      { action: 'Expand / collapse server', how: 'Click the server row to toggle its tools and prompts' },
      { action: 'Enable / disable server',  how: 'Check or uncheck the box on the server row' },
      { action: 'Enable / disable tool',    how: 'Check or uncheck the box next to any tool name' },
      { action: 'Refresh a server',         how: 'Hover over a server row — click the refresh icon that appears' },
      { action: 'Refresh all servers',      how: 'Click the global refresh icon in the sidebar header' },
      { action: 'Preview a prompt',         how: 'Click Preview under a prompt — expands the rendered messages' },
      { action: 'Use a prompt',             how: 'Click Use — loads the prompt as context above the chat input' },
    ],
  },
  {
    title: 'Status Bar',
    rows: [
      { action: 'View token details',  how: 'Click the token bar or count — opens usage popover' },
      { action: 'View cost breakdown', how: 'Click the token/cost area — popover shows per-call data' },
      { action: 'Switch provider',     how: 'Select a provider from the dropdown in the status bar' },
      { action: 'Switch model',        how: 'Select a model from the model dropdown, then click Apply' },
    ],
  },
  {
    title: 'Panels and Modals',
    rows: [
      { action: 'Close any panel',     how: 'Click × in the header, click the backdrop, or press Escape' },
      { action: 'Restore a chat',      how: 'Chat History → click Restore on a session' },
      { action: 'Rename a chat',       how: 'Chat History → click Rename or double-click the session name' },
      { action: 'Export a chat',       how: 'Chat History → click JSON or MD buttons on a session' },
      { action: 'Re-execute a tool',   how: 'Tool Replay → expand a tool call, click Re-execute' },
      { action: 'HIL approval',        how: 'When HIL is on in Settings, an approval modal appears before each tool call' },
    ],
  },
];

export function HelpPanel({ open, onClose }: HelpPanelProps) {
  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel--lg modal-panel--help" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Help</span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body help-panel__body">
          {HELP_SECTIONS.map(section => (
            <div key={section.title} className="help-panel__section">
              <div className="help-panel__section-title">{section.title}</div>
              <div className="help-panel__table">
                {section.rows.map((row, i) => (
                  <div key={i} className="help-panel__row">
                    <span className="help-panel__action">{row.action}</span>
                    <span className="help-panel__how">{row.how}</span>
                    {row.kbd ? (
                      <span className="help-panel__kbd-wrap">
                        {row.kbd.split('+').map((key, ki) => (
                          <span key={ki}>
                            <kbd className="help-panel__kbd">{key}</kbd>
                            {ki < (row.kbd ?? '').split('+').length - 1 && (
                              <span className="help-panel__kbd-plus">+</span>
                            )}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
