/**
 * Path utilities for filesystem operations.
 */

/**
 * Sanitizes a string for use as a folder name.
 * - Converts to lowercase
 * - Removes special characters (keeps alphanumeric, spaces, hyphens)
 * - Replaces spaces with hyphens
 * - Collapses multiple hyphens
 * - Removes leading/trailing hyphens
 */
export function sanitizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
