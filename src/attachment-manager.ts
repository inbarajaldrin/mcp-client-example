import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface AttachmentInfo {
  path: string;
  fileName: string;
  ext: string;
  mediaType: string;
}

// OPTION 2: Proper separation of document and image types
export type ContentBlock = 
  | DocumentBlock
  | ImageBlock
  | TextBlock;

export interface DocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: 'application/pdf';
    data: string;
  };
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export class AttachmentManager {
  private logger: Logger;
  private attachmentsDir: string;

  constructor(logger: Logger) {
    this.logger = logger;
    this.attachmentsDir = join(__dirname, '..', '.mcp-client-data', 'attachments');
    this.ensureAttachmentsDir();
  }

  /**
   * Ensure the attachments directory exists
   */
  private ensureAttachmentsDir(): void {
    if (!fs.existsSync(this.attachmentsDir)) {
      fs.mkdirSync(this.attachmentsDir, { recursive: true });
    }
  }

  /**
   * Get the attachments directory path
   */
  getAttachmentsDir(): string {
    return this.attachmentsDir;
  }

  /**
   * Map file extension to MIME type
   */
  getMediaType(ext: string): string {
    const types: Record<string, string> = {
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
    return types[ext.toLowerCase()] || 'application/octet-stream';
  }

  /**
   * Validate file exists and copy it to attachments directory
   * Returns attachment info if successful, null if failed
   */
  copyFileToAttachments(filePath: string): AttachmentInfo | null {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        this.logger.log('❌ File not found\n', { type: 'error' });
        return null;
      }

      // Get file stats to check if it's a file (not a directory)
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        this.logger.log('❌ Path is not a file\n', { type: 'error' });
        return null;
      }

      // Ensure attachments directory exists
      this.ensureAttachmentsDir();

      // Get file name and extension
      const fileName = path.basename(filePath);
      const ext = path.extname(fileName).toLowerCase();
      const mediaType = this.getMediaType(ext);

      // Handle duplicate file names by appending a number
      let destPath = path.join(this.attachmentsDir, fileName);
      let counter = 1;
      while (fs.existsSync(destPath)) {
        const nameWithoutExt = path.basename(fileName, ext);
        const newFileName = `${nameWithoutExt}_${counter}${ext}`;
        destPath = path.join(this.attachmentsDir, newFileName);
        counter++;
      }

      // Copy file to attachments directory
      fs.copyFileSync(filePath, destPath);

      const attachmentInfo: AttachmentInfo = {
        path: destPath,
        fileName: path.basename(destPath),
        ext,
        mediaType,
      };

      this.logger.log(`✓ File loaded: ${attachmentInfo.fileName}\n`, { type: 'success' });
      this.logger.log(`   Saved to: ${destPath}\n`, { type: 'info' });
      return attachmentInfo;
    } catch (error) {
      this.logger.log(
        `❌ Error loading file: ${error instanceof Error ? error.message : String(error)}\n`,
        { type: 'error' },
      );
      return null;
    }
  }

  /**
   * Read file and encode as base64
   */
  readFileAsBase64(filePath: string): string | null {
    try {
      if (!fs.existsSync(filePath)) {
        this.logger.log('❌ File not found for base64 encoding\n', { type: 'error' });
        return null;
      }

      const fileBuffer = fs.readFileSync(filePath);
      return fileBuffer.toString('base64');
    } catch (error) {
      this.logger.log(
        `❌ Error reading file as base64: ${error instanceof Error ? error.message : String(error)}\n`,
        { type: 'error' },
      );
      return null;
    }
  }

  /**
   * Create content blocks from attachments and optional text
   * Properly separates PDFs from images using dedicated content block types
   * 
   * @param attachments - Array of attachment info
   * @param text - Optional text to include
   * @returns Array of properly typed content blocks
   */
  createContentBlocks(attachments: AttachmentInfo[], text?: string): ContentBlock[] {
    const contentBlocks: ContentBlock[] = [];

    // Add attachment blocks first
    for (const attachment of attachments) {
      const base64Data = this.readFileAsBase64(attachment.path);
      if (!base64Data) {
        this.logger.log(
          `⚠️  Skipping attachment ${attachment.fileName} - failed to read as base64\n`,
          { type: 'warning' },
        );
        continue;
      }

      // OPTION 2: Properly separate PDFs from images
      if (attachment.mediaType === 'application/pdf') {
        // PDF: Use dedicated 'document' type
        contentBlocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64Data,
          },
        } as DocumentBlock);
        this.logger.log(`✓ Added PDF: ${attachment.fileName}\n`, { type: 'success' });
      } 
      else if (attachment.mediaType.startsWith('image/')) {
        // Image: Use 'image' type with validation
        const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        
        if (!validImageTypes.includes(attachment.mediaType)) {
          this.logger.log(
            `⚠️  Skipping image ${attachment.fileName} - unsupported format ${attachment.mediaType}\n`,
            { type: 'warning' },
          );
          continue;
        }

        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: base64Data,
          },
        } as ImageBlock);
        this.logger.log(`✓ Added image: ${attachment.fileName}\n`, { type: 'success' });
      }
      else if (attachment.mediaType.startsWith('text/')) {
        // Text: Read and include as text content
        try {
          const textContent = fs.readFileSync(attachment.path, 'utf-8');
          contentBlocks.push({
            type: 'text',
            text: `[File: ${attachment.fileName}]\n${textContent}`,
          } as TextBlock);
          this.logger.log(`✓ Added text file: ${attachment.fileName}\n`, { type: 'success' });
        } catch (error) {
          this.logger.log(
            `⚠️  Skipping text file ${attachment.fileName} - failed to read\n`,
            { type: 'warning' },
          );
        }
      }
      else {
        // Unsupported format
        this.logger.log(
          `⚠️  Skipping ${attachment.fileName} - unsupported format ${attachment.mediaType}\n`,
          { type: 'warning' },
        );
      }
    }

    // Add text block at the end if provided
    if (text && text.trim()) {
      contentBlocks.push({
        type: 'text',
        text: text.trim(),
      } as TextBlock);
    }

    return contentBlocks;
  }

  /**
   * List all attachments in the attachments directory
   */
  listAttachments(): AttachmentInfo[] {
    try {
      this.ensureAttachmentsDir();
      
      if (!fs.existsSync(this.attachmentsDir)) {
        return [];
      }

      const files = fs.readdirSync(this.attachmentsDir);
      const attachments: AttachmentInfo[] = [];

      for (const file of files) {
        const filePath = path.join(this.attachmentsDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile()) {
            const ext = path.extname(file).toLowerCase();
            attachments.push({
              path: filePath,
              fileName: file,
              ext,
              mediaType: this.getMediaType(ext),
            });
          }
        } catch (error) {
          // Skip files that can't be accessed
          continue;
        }
      }

      // Sort by file name
      attachments.sort((a, b) => a.fileName.localeCompare(b.fileName));
      return attachments;
    } catch (error) {
      this.logger.log(
        `⚠️  Error listing attachments: ${error instanceof Error ? error.message : String(error)}\n`,
        { type: 'warning' },
      );
      return [];
    }
  }

  /**
   * Get attachment info by file name
   */
  getAttachmentInfo(fileName: string): AttachmentInfo | null {
    const filePath = path.join(this.attachmentsDir, fileName);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return null;
    }

    const ext = path.extname(fileName).toLowerCase();
    return {
      path: filePath,
      fileName,
      ext,
      mediaType: this.getMediaType(ext),
    };
  }

  /**
   * Rename an attachment
   */
  renameAttachment(oldFileName: string, newFileName: string): boolean {
    try {
      const oldPath = path.join(this.attachmentsDir, oldFileName);
      const newPath = path.join(this.attachmentsDir, newFileName);

      if (!fs.existsSync(oldPath)) {
        this.logger.log(`❌ Attachment not found: ${oldFileName}\n`, { type: 'error' });
        return false;
      }

      if (fs.existsSync(newPath)) {
        this.logger.log(`❌ File already exists: ${newFileName}\n`, { type: 'error' });
        return false;
      }

      fs.renameSync(oldPath, newPath);
      this.logger.log(`✓ Renamed: ${oldFileName} → ${newFileName}\n`, { type: 'success' });
      return true;
    } catch (error) {
      this.logger.log(
        `❌ Error renaming attachment: ${error instanceof Error ? error.message : String(error)}\n`,
        { type: 'error' },
      );
      return false;
    }
  }

  /**
   * Delete one or more attachments
   */
  deleteAttachments(fileNames: string[]): { deleted: string[]; failed: string[] } {
    const deleted: string[] = [];
    const failed: string[] = [];

    for (const fileName of fileNames) {
      try {
        const filePath = path.join(this.attachmentsDir, fileName);
        if (!fs.existsSync(filePath)) {
          failed.push(fileName);
          this.logger.log(`⚠️  Attachment not found: ${fileName}\n`, { type: 'warning' });
          continue;
        }

        fs.unlinkSync(filePath);
        deleted.push(fileName);
      } catch (error) {
        failed.push(fileName);
        this.logger.log(
          `❌ Error deleting ${fileName}: ${error instanceof Error ? error.message : String(error)}\n`,
          { type: 'error' },
        );
      }
    }

    if (deleted.length > 0) {
      this.logger.log(
        `✓ Deleted ${deleted.length} attachment(s)\n`,
        { type: 'success' },
      );
    }

    return { deleted, failed };
  }

  /**
   * Clean up old attachments (optional utility method)
   * Can be used to remove attachments older than a certain age
   */
  cleanupOldAttachments(maxAgeDays: number = 30): void {
    try {
      if (!fs.existsSync(this.attachmentsDir)) {
        return;
      }

      const files = fs.readdirSync(this.attachmentsDir);
      const now = Date.now();
      const maxAge = maxAgeDays * 24 * 60 * 60 * 1000; // Convert days to milliseconds
      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.attachmentsDir, file);
        try {
          const stats = fs.statSync(filePath);
          const age = now - stats.mtimeMs;

          if (age > maxAge) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        } catch (error) {
          // Skip files that can't be accessed
          continue;
        }
      }

      if (deletedCount > 0) {
        this.logger.log(
          `✓ Cleaned up ${deletedCount} old attachment(s)\n`,
          { type: 'info' },
        );
      }
    } catch (error) {
      this.logger.log(
        `⚠️  Error cleaning up attachments: ${error instanceof Error ? error.message : String(error)}\n`,
        { type: 'warning' },
      );
    }
  }
}