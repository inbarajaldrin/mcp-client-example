/**
 * File and directory operation utilities.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  renameSync,
  rmdirSync,
} from 'fs';
import { join } from 'path';

/**
 * Check if a directory contains any files (recursively).
 * @param dirPath - Directory path to check
 * @returns true if directory contains at least one file, false otherwise
 */
export function directoryHasFiles(dirPath: string): boolean {
  try {
    const items = readdirSync(dirPath);

    for (const item of items) {
      const itemPath = join(dirPath, item);
      try {
        const stats = statSync(itemPath);

        if (stats.isFile()) {
          return true; // Found at least one file
        } else if (stats.isDirectory()) {
          // Recursively check subdirectory
          if (directoryHasFiles(itemPath)) {
            return true;
          }
        }
      } catch (error) {
        // Skip items that can't be accessed
        continue;
      }
    }

    return false; // No files found
  } catch (error) {
    return false;
  }
}

/**
 * Recursively copy a directory.
 * Only copies directories that contain files (skips empty directories).
 * @param sourceDir - Source directory path
 * @param destDir - Destination directory path
 */
export function copyDirectoryRecursive(sourceDir: string, destDir: string): void {
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const items = readdirSync(sourceDir);

  for (const item of items) {
    const sourcePath = join(sourceDir, item);
    const destPath = join(destDir, item);

    try {
      const stats = statSync(sourcePath);

      if (stats.isFile()) {
        copyFileSync(sourcePath, destPath);
      } else if (stats.isDirectory()) {
        // Only copy directory if it contains files
        if (directoryHasFiles(sourcePath)) {
          copyDirectoryRecursive(sourcePath, destPath);
        }
      }
    } catch (error) {
      // Skip items that can't be copied
      continue;
    }
  }
}

/**
 * Recursively move a directory (files are moved, not copied).
 * Only moves directories that contain files (skips empty directories).
 * Removes empty source directories after moving contents.
 * @param sourceDir - Source directory path
 * @param destDir - Destination directory path
 */
export function moveDirectoryRecursive(sourceDir: string, destDir: string): void {
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const items = readdirSync(sourceDir);

  for (const item of items) {
    const sourcePath = join(sourceDir, item);
    const destPath = join(destDir, item);

    try {
      const stats = statSync(sourcePath);

      if (stats.isFile()) {
        // Move file (remove from source)
        renameSync(sourcePath, destPath);
      } else if (stats.isDirectory()) {
        // Only move directory if it contains files
        if (directoryHasFiles(sourcePath)) {
          moveDirectoryRecursive(sourcePath, destPath);
          // Remove empty source directory after moving contents
          try {
            const remainingItems = readdirSync(sourcePath);
            if (remainingItems.length === 0) {
              rmdirSync(sourcePath);
            }
          } catch (error) {
            // Ignore errors when removing directory
          }
        }
      }
    } catch (error) {
      // Skip items that can't be moved
      continue;
    }
  }

  // Try to remove source directory if it's now empty
  try {
    const remainingItems = readdirSync(sourceDir);
    if (remainingItems.length === 0) {
      rmdirSync(sourceDir);
    }
  } catch (error) {
    // Ignore errors when removing directory
  }
}
