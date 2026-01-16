/**
 * MIME type utilities for file handling.
 */

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

/**
 * Get the MIME type for a file extension.
 * @param ext - File extension (with or without leading dot)
 * @returns MIME type string, or 'application/octet-stream' for unknown types
 */
export function getMediaType(ext: string): string {
  const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return MIME_TYPES[normalizedExt] || 'application/octet-stream';
}
