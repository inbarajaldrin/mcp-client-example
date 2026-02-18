import { useState, useCallback } from 'react';

export interface ApprovalRequest {
  type: 'approval';
  toolName: string;
  toolInput: Record<string, any>;
  requestId: string;
}

export interface ElicitationField {
  type: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  oneOf?: Array<{ const: string; title: string }>;
  items?: { type?: string; enum?: string[] } | { anyOf?: Array<{ const: string; title: string }> };
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  default?: any;
}

export interface ElicitationSchema {
  type: 'object';
  properties: Record<string, ElicitationField>;
  required?: string[];
}

export interface ElicitationRequest {
  type: 'elicitation';
  message: string;
  requestedSchema: ElicitationSchema;
  requestId: string;
}

export type PendingRequest = ApprovalRequest | ElicitationRequest;

export function useApproval() {
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);

  const handleApprovalEvent = useCallback((toolName: string, toolInput: Record<string, any>, requestId: string) => {
    setPendingRequest({ type: 'approval', toolName, toolInput, requestId });
  }, []);

  const handleElicitationEvent = useCallback((message: string, requestedSchema: ElicitationSchema, requestId: string) => {
    setPendingRequest({ type: 'elicitation', message, requestedSchema, requestId });
  }, []);

  const respondApproval = useCallback(async (requestId: string, decision: 'execute' | 'reject', message?: string) => {
    await fetch('/api/chat/approval-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, decision, message }),
    });
    setPendingRequest(null);
  }, []);

  const respondElicitation = useCallback(async (requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, any>) => {
    await fetch('/api/chat/elicitation-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, action, content }),
    });
    setPendingRequest(null);
  }, []);

  const clearPending = useCallback(() => {
    setPendingRequest(null);
  }, []);

  return {
    pendingRequest,
    handleApprovalEvent,
    handleElicitationEvent,
    respondApproval,
    respondElicitation,
    clearPending,
  };
}
