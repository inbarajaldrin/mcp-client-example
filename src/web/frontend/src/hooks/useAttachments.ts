import { useState, useCallback, useEffect } from 'react';

export interface Attachment {
  fileName: string;
  ext: string;
  mediaType: string;
  previewUrl?: string;
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAttachments = useCallback(() => {
    fetch('/api/attachments')
      .then(res => res.json())
      .then((data: Attachment[]) => {
        setAttachments(data);
        setError(null);
      })
      .catch(() => setError('Failed to load attachments'));
  }, []);

  useEffect(() => {
    fetchAttachments();
  }, [fetchAttachments]);

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/attachments/upload', {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Upload failed' }));
        setError(data.error ?? 'Upload failed');
        return null;
      }
      const { attachment } = await res.json() as { ok: boolean; attachment: Attachment };
      if (file.type.startsWith('image/')) {
        attachment.previewUrl = URL.createObjectURL(file);
      }
      setAttachments(prev => [...prev, attachment]);
      setPendingAttachments(prev => [...prev, attachment]);
      return attachment;
    } catch {
      setError('Upload failed');
      return null;
    } finally {
      setUploading(false);
    }
  }, []);

  const deleteAttachment = useCallback(async (fileName: string) => {
    try {
      const res = await fetch(`/api/attachments/${encodeURIComponent(fileName)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError('Delete failed');
        return false;
      }
      setAttachments(prev => prev.filter(a => a.fileName !== fileName));
      setPendingAttachments(prev => prev.filter(a => a.fileName !== fileName));
      return true;
    } catch {
      setError('Delete failed');
      return false;
    }
  }, []);

  const addPending = useCallback((attachment: Attachment) => {
    setPendingAttachments(prev => {
      if (prev.some(a => a.fileName === attachment.fileName)) return prev;
      return [...prev, attachment];
    });
  }, []);

  const removePending = useCallback((fileName: string) => {
    setPendingAttachments(prev => {
      const removed = prev.find(a => a.fileName === fileName);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter(a => a.fileName !== fileName);
    });
  }, []);

  const clearPending = useCallback(() => {
    setPendingAttachments(prev => {
      prev.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      return [];
    });
  }, []);

  return {
    attachments,
    pendingAttachments,
    uploading,
    error,
    fetchAttachments,
    uploadFile,
    deleteAttachment,
    addPending,
    removePending,
    clearPending,
  };
}
