import { useState } from 'react';
import type { PendingRequest, ElicitationField, ElicitationSchema } from '../hooks/useApproval';

interface ApprovalModalProps {
  pendingRequest: PendingRequest | null;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string, message?: string) => void;
  onElicitationSubmit: (requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, any>) => void;
}

function ElicitationForm({
  schema,
  onSubmit,
  onDecline,
  onCancel,
}: {
  schema: ElicitationSchema;
  onSubmit: (content: Record<string, any>) => void;
  onDecline: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, any>>(() => {
    const defaults: Record<string, any> = {};
    for (const [key, field] of Object.entries(schema.properties)) {
      if (field.default !== undefined) defaults[key] = field.default;
    }
    return defaults;
  });

  const required = new Set(schema.required || []);

  const setValue = (key: string, val: any) => {
    setValues(prev => ({ ...prev, [key]: val }));
  };

  const handleSubmit = () => {
    // Validate required fields
    for (const key of required) {
      const v = values[key];
      if (v === undefined || v === '' || v === null) return;
    }
    onSubmit(values);
  };

  const renderField = (name: string, field: ElicitationField) => {
    const isRequired = required.has(name);
    const label = field.title || name;

    if (field.type === 'boolean') {
      return (
        <label className="approval-modal__field" key={name}>
          <span className="approval-modal__field-label">{label}{isRequired ? ' *' : ''}</span>
          {field.description && <span className="approval-modal__field-desc">{field.description}</span>}
          <div className="approval-modal__toggle-row">
            <input
              type="checkbox"
              checked={!!values[name]}
              onChange={e => setValue(name, e.target.checked)}
            />
            <span>{values[name] ? 'Yes' : 'No'}</span>
          </div>
        </label>
      );
    }

    if (field.type === 'number' || field.type === 'integer') {
      return (
        <label className="approval-modal__field" key={name}>
          <span className="approval-modal__field-label">{label}{isRequired ? ' *' : ''}</span>
          {field.description && <span className="approval-modal__field-desc">{field.description}</span>}
          <input
            className="approval-modal__input"
            type="number"
            value={values[name] ?? ''}
            min={field.minimum}
            max={field.maximum}
            step={field.type === 'integer' ? 1 : 'any'}
            onChange={e => setValue(name, e.target.value === '' ? undefined : Number(e.target.value))}
            placeholder={isRequired ? 'Required' : 'Optional'}
          />
        </label>
      );
    }

    if (field.type === 'string' && field.enum) {
      return (
        <label className="approval-modal__field" key={name}>
          <span className="approval-modal__field-label">{label}{isRequired ? ' *' : ''}</span>
          {field.description && <span className="approval-modal__field-desc">{field.description}</span>}
          <select
            className="approval-modal__select"
            value={values[name] ?? ''}
            onChange={e => setValue(name, e.target.value || undefined)}
          >
            <option value="">Select...</option>
            {field.enum.map((opt, i) => (
              <option key={opt} value={opt}>{field.enumNames?.[i] || opt}</option>
            ))}
          </select>
        </label>
      );
    }

    if (field.type === 'string' && field.oneOf) {
      return (
        <label className="approval-modal__field" key={name}>
          <span className="approval-modal__field-label">{label}{isRequired ? ' *' : ''}</span>
          {field.description && <span className="approval-modal__field-desc">{field.description}</span>}
          <select
            className="approval-modal__select"
            value={values[name] ?? ''}
            onChange={e => setValue(name, e.target.value || undefined)}
          >
            <option value="">Select...</option>
            {field.oneOf.map(opt => (
              <option key={opt.const} value={opt.const}>{opt.title}</option>
            ))}
          </select>
        </label>
      );
    }

    // Default: text input
    return (
      <label className="approval-modal__field" key={name}>
        <span className="approval-modal__field-label">{label}{isRequired ? ' *' : ''}</span>
        {field.description && <span className="approval-modal__field-desc">{field.description}</span>}
        <input
          className="approval-modal__input"
          type="text"
          value={values[name] ?? ''}
          onChange={e => setValue(name, e.target.value || undefined)}
          placeholder={isRequired ? 'Required' : 'Optional'}
        />
      </label>
    );
  };

  return (
    <div className="approval-modal__form">
      {Object.entries(schema.properties).map(([name, field]) => renderField(name, field))}
      <div className="approval-modal__actions">
        <button className="approval-modal__btn approval-modal__btn--approve" onClick={handleSubmit}>Submit</button>
        <button className="approval-modal__btn approval-modal__btn--reject" onClick={onDecline}>Decline</button>
        <button className="approval-modal__btn approval-modal__btn--cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function ApprovalModal({ pendingRequest, onApprove, onReject, onElicitationSubmit }: ApprovalModalProps) {
  const [rejectMessage, setRejectMessage] = useState('');

  if (!pendingRequest) return null;

  if (pendingRequest.type === 'approval') {
    const cleanName = pendingRequest.toolName.includes('__')
      ? pendingRequest.toolName.split('__').slice(1).join('__')
      : pendingRequest.toolName;
    const serverName = pendingRequest.toolName.includes('__')
      ? pendingRequest.toolName.split('__')[0]
      : null;

    return (
      <div className="approval-modal__overlay">
        <div className="approval-modal">
          <div className="approval-modal__header">Tool Approval Required</div>
          <div className="approval-modal__body">
            <div className="approval-modal__tool-name">
              {cleanName}
              {serverName && <span className="approval-modal__server-name">{serverName}</span>}
            </div>
            {Object.keys(pendingRequest.toolInput).length > 0 && (
              <div className="approval-modal__args">
                <div className="approval-modal__args-label">Arguments:</div>
                <pre className="approval-modal__args-json">
                  {JSON.stringify(pendingRequest.toolInput, null, 2)}
                </pre>
              </div>
            )}
            <div className="approval-modal__reject-row">
              <input
                className="approval-modal__input"
                type="text"
                value={rejectMessage}
                onChange={e => setRejectMessage(e.target.value)}
                placeholder="Rejection reason (optional)"
              />
            </div>
          </div>
          <div className="approval-modal__actions">
            <button
              className="approval-modal__btn approval-modal__btn--approve"
              onClick={() => { onApprove(pendingRequest.requestId); setRejectMessage(''); }}
            >
              Approve
            </button>
            <button
              className="approval-modal__btn approval-modal__btn--reject"
              onClick={() => { onReject(pendingRequest.requestId, rejectMessage || undefined); setRejectMessage(''); }}
            >
              Reject
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Elicitation request
  return (
    <div className="approval-modal__overlay">
      <div className="approval-modal">
        <div className="approval-modal__header">Server Request</div>
        <div className="approval-modal__body">
          <div className="approval-modal__message">{pendingRequest.message}</div>
          <ElicitationForm
            schema={pendingRequest.requestedSchema}
            onSubmit={content => onElicitationSubmit(pendingRequest.requestId, 'accept', content)}
            onDecline={() => onElicitationSubmit(pendingRequest.requestId, 'decline')}
            onCancel={() => onElicitationSubmit(pendingRequest.requestId, 'cancel')}
          />
        </div>
      </div>
    </div>
  );
}
