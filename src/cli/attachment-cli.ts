/**
 * CLI operations for attachment management.
 */

import readline from 'readline/promises';
import {
  AttachmentManager,
  type AttachmentInfo,
} from '../managers/attachment-manager.js';
import { Logger } from '../logger.js';

/**
 * Callbacks for attachment CLI to interact with parent component.
 */
export interface AttachmentCLICallbacks {
  /** Get current readline interface */
  getReadline: () => readline.Interface | null;
  /** Get pending attachments */
  getPendingAttachments: () => AttachmentInfo[];
  /** Set pending attachments */
  setPendingAttachments: (attachments: AttachmentInfo[]) => void;
  /** Get provider name (for PDF filtering) */
  getProviderName: () => string;
}

/**
 * Handles CLI operations for attachment upload, listing, selection, and deletion.
 */
export class AttachmentCLI {
  private attachmentManager: AttachmentManager;
  private logger: Logger;
  private callbacks: AttachmentCLICallbacks;

  constructor(
    attachmentManager: AttachmentManager,
    logger: Logger,
    callbacks: AttachmentCLICallbacks,
  ) {
    this.attachmentManager = attachmentManager;
    this.logger = logger;
    this.callbacks = callbacks;
  }

  /**
   * Handle /attachment-upload command - Upload files to attachments.
   */
  async handleAttachmentCommand(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    this.logger.log('\n📎 Attachment Mode\n', { type: 'info' });
    this.logger.log(
      'Drag and drop files into the terminal, or type file paths (one per line).\n',
      { type: 'info' },
    );
    this.logger.log('Type "done" when finished, or "cancel" to abort.\n', {
      type: 'info',
    });

    const attachments: AttachmentInfo[] = [];

    while (true) {
      const input = (await rl.question('> ')).trim();

      if (input.toLowerCase() === 'done' || input.toLowerCase() === 'd') {
        if (attachments.length === 0) {
          this.logger.log('No files attached. Cancelling.\n', {
            type: 'warning',
          });
          return;
        }
        break;
      }

      if (input.toLowerCase() === 'cancel' || input.toLowerCase() === 'c') {
        this.logger.log('Attachment cancelled.\n', { type: 'warning' });
        return;
      }

      if (!input) {
        continue;
      }

      // Handle file path (could be from drag-and-drop or typed)
      // Remove quotes if present (some terminals add them)
      const filePath = input.replace(/^["']|["']$/g, '');

      const attachment = this.attachmentManager.copyFileToAttachments(filePath);
      if (attachment) {
        attachments.push(attachment);
        this.logger.log(
          `  (${attachments.length} file${attachments.length > 1 ? 's' : ''} attached)\n`,
          { type: 'info' },
        );
      }
    }

    // Store attachments to be used with the next user message
    this.callbacks.setPendingAttachments(attachments);
    this.logger.log(
      `\n✓ ${attachments.length} file${attachments.length > 1 ? 's' : ''} attached. They will be included with your next message.\n`,
      { type: 'success' },
    );
    this.logger.log('You can now type your question or prompt.\n', {
      type: 'info',
    });
  }

  /**
   * Handle /attachment-list command - List available attachments.
   */
  async handleAttachmentListCommand(): Promise<void> {
    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n📎 No attachments found.\n', { type: 'info' });
      this.logger.log('Use /attachment-upload to add attachments.\n', {
        type: 'info',
      });
      return;
    }

    this.logger.log(`\n📎 Available Attachments (${attachments.length}):\n`, {
      type: 'info',
    });

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const fs = await import('fs');
      const stats = fs.statSync(att.path);
      const sizeKB = (stats.size / 1024).toFixed(2);
      const date = new Date(stats.mtime).toLocaleString();

      this.logger.log(`  ${i + 1}. ${att.fileName}\n`, { type: 'info' });
      this.logger.log(
        `     Type: ${att.mediaType} | Size: ${sizeKB} KB | Modified: ${date}\n`,
        { type: 'info' },
      );
    }
    this.logger.log('\n');
  }

  /**
   * Handle /attachment-select command - Select attachments for use.
   */
  async handleAttachmentSelectCommand(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n📎 No attachments available to select.\n', {
        type: 'warning',
      });
      this.logger.log('Use /attachment-upload to add attachments.\n', {
        type: 'info',
      });
      return;
    }

    this.logger.log('\n📎 Select Attachments:\n', { type: 'info' });
    this.logger.log(
      'Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to select attachments.\n',
      { type: 'info' },
    );

    // Display attachments with indices
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const fs = await import('fs');
      const stats = fs.statSync(att.path);
      const sizeKB = (stats.size / 1024).toFixed(2);

      this.logger.log(
        `  ${i + 1}. ${att.fileName} (${att.mediaType}, ${sizeKB} KB)\n`,
        { type: 'info' },
      );
    }

    this.logger.log('\nEnter selection (or "q" to cancel):\n', { type: 'info' });
    const selection = (await rl.question('> ')).trim();

    if (
      selection.toLowerCase() === 'q' ||
      selection.toLowerCase() === 'quit'
    ) {
      this.logger.log('\nSelection cancelled.\n', { type: 'warning' });
      return;
    }

    // Parse selection
    const parts = selection.split(',').map((p) => p.trim());
    const selectedIndices: number[] = [];

    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map((n) => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            selectedIndices.push(i);
          }
        }
      } else {
        const num = parseInt(part);
        if (!isNaN(num)) {
          selectedIndices.push(num);
        }
      }
    }

    // Remove duplicates and sort
    const uniqueIndices = [...new Set(selectedIndices)].sort((a, b) => a - b);

    // Validate indices
    const validIndices = uniqueIndices.filter(
      (idx) => idx >= 1 && idx <= attachments.length,
    );

    if (validIndices.length === 0) {
      this.logger.log('\n✗ No valid attachments selected.\n', { type: 'error' });
      return;
    }

    // Get selected attachments
    const selectedAttachments = validIndices.map((idx) => attachments[idx - 1]);

    // Check if OpenAI is being used and filter out PDFs
    const providerName = this.callbacks.getProviderName();
    let finalAttachments = selectedAttachments;

    if (providerName === 'openai') {
      const pdfAttachments = selectedAttachments.filter(
        (att) => att.mediaType === 'application/pdf',
      );
      const nonPdfAttachments = selectedAttachments.filter(
        (att) => att.mediaType !== 'application/pdf',
      );

      if (pdfAttachments.length > 0) {
        this.logger.log(
          `\n⚠️  Warning: PDF attachments are not supported by OpenAI.\n`,
          { type: 'warning' },
        );
        this.logger.log(
          `   ${pdfAttachments.length} PDF file(s) excluded: ${pdfAttachments.map((a) => a.fileName).join(', ')}\n`,
          { type: 'warning' },
        );
        this.logger.log(
          `   Please use Anthropic provider (--provider=anthropic) for PDF support.\n`,
          { type: 'info' },
        );

        if (nonPdfAttachments.length === 0) {
          this.logger.log(
            `\n✗ No valid attachments selected (all were PDFs).\n`,
            { type: 'error' },
          );
          return;
        }
      }

      finalAttachments = nonPdfAttachments;
    }

    // Store as pending attachments (only non-PDFs for OpenAI)
    this.callbacks.setPendingAttachments(finalAttachments);

    this.logger.log(
      `\n✓ ${finalAttachments.length} attachment(s) selected. They will be included with your next message.\n`,
      { type: 'success' },
    );
    this.logger.log('You can now type your question or prompt.\n', {
      type: 'info',
    });
  }

  /**
   * Handle /attachment-rename command - Rename an attachment.
   */
  async handleAttachmentRenameCommand(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n📎 No attachments available to rename.\n', {
        type: 'warning',
      });
      this.logger.log('Use /attachment-upload to add attachments.\n', {
        type: 'info',
      });
      return;
    }

    this.logger.log('\n📎 Select Attachment to Rename:\n', { type: 'info' });

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      this.logger.log(`  ${i + 1}. ${att.fileName}\n`, { type: 'info' });
    }

    const selection = (
      await rl.question('\nEnter number (or "q" to cancel): ')
    ).trim();

    if (
      selection.toLowerCase() === 'q' ||
      selection.toLowerCase() === 'quit'
    ) {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const index = parseInt(selection) - 1;
    if (isNaN(index) || index < 0 || index >= attachments.length) {
      this.logger.log('\nInvalid selection.\n', { type: 'error' });
      return;
    }

    const selectedAttachment = attachments[index];
    this.logger.log(`\nCurrent name: ${selectedAttachment.fileName}\n`, {
      type: 'info',
    });

    const newName = (await rl.question('Enter new name: ')).trim();

    if (!newName) {
      this.logger.log('\nName cannot be empty.\n', { type: 'error' });
      return;
    }

    // Validate new name (basic validation)
    if (newName.includes('/') || newName.includes('\\')) {
      this.logger.log('\nName cannot contain path separators.\n', {
        type: 'error',
      });
      return;
    }

    const success = this.attachmentManager.renameAttachment(
      selectedAttachment.fileName,
      newName,
    );

    if (success) {
      // If this attachment was in pending attachments, update it
      const pendingAttachments = this.callbacks.getPendingAttachments();
      const pendingIndex = pendingAttachments.findIndex(
        (att) => att.fileName === selectedAttachment.fileName,
      );
      if (pendingIndex !== -1) {
        const updatedInfo = this.attachmentManager.getAttachmentInfo(newName);
        if (updatedInfo) {
          pendingAttachments[pendingIndex] = updatedInfo;
          this.callbacks.setPendingAttachments(pendingAttachments);
        }
      }
    }
  }

  /**
   * Handle /attachment-clear command - Delete attachments.
   */
  async handleAttachmentClearCommand(): Promise<void> {
    const rl = this.callbacks.getReadline();
    if (!rl) {
      throw new Error('Readline interface not initialized');
    }

    const attachments = this.attachmentManager.listAttachments();

    if (attachments.length === 0) {
      this.logger.log('\n📎 No attachments available to delete.\n', {
        type: 'warning',
      });
      return;
    }

    this.logger.log('\n🗑️  Select Attachments to Delete:\n', { type: 'info' });
    this.logger.log(
      'Enter numbers separated by commas or ranges (e.g., 1,3,5-8) to select attachments.\n',
      { type: 'info' },
    );
    this.logger.log(
      `  0. Delete ALL attachments (${attachments.length} total)\n`,
      { type: 'warning' },
    );

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const fs = await import('fs');
      const stats = fs.statSync(att.path);
      const sizeKB = (stats.size / 1024).toFixed(2);

      this.logger.log(
        `  ${i + 1}. ${att.fileName} (${att.mediaType}, ${sizeKB} KB)\n`,
        { type: 'info' },
      );
    }

    const selection = (
      await rl.question('\nEnter selection (or "q" to cancel): ')
    ).trim();

    if (
      selection.toLowerCase() === 'q' ||
      selection.toLowerCase() === 'quit'
    ) {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    // Handle "delete all" option
    if (selection === '0') {
      const confirm = (
        await rl.question(
          `\n⚠️  Are you sure you want to delete ALL ${attachments.length} attachment(s)? This cannot be undone! (yes/no): `,
        )
      )
        .trim()
        .toLowerCase();

      if (confirm !== 'yes' && confirm !== 'y') {
        this.logger.log('\nCancelled.\n', { type: 'info' });
        return;
      }

      const fileNames = attachments.map((att) => att.fileName);
      const result = this.attachmentManager.deleteAttachments(fileNames);

      if (result.deleted.length > 0) {
        // Remove deleted attachments from pending list
        const pendingAttachments = this.callbacks.getPendingAttachments();
        this.callbacks.setPendingAttachments(
          pendingAttachments.filter(
            (att) => !result.deleted.includes(att.fileName),
          ),
        );
      }
      return;
    }

    // Parse selection
    const parts = selection.split(',').map((p) => p.trim());
    const selectedIndices: number[] = [];

    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map((n) => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            selectedIndices.push(i);
          }
        }
      } else {
        const num = parseInt(part);
        if (!isNaN(num)) {
          selectedIndices.push(num);
        }
      }
    }

    // Remove duplicates and sort
    const uniqueIndices = [...new Set(selectedIndices)].sort((a, b) => a - b);

    // Validate indices
    const validIndices = uniqueIndices.filter(
      (idx) => idx >= 1 && idx <= attachments.length,
    );

    if (validIndices.length === 0) {
      this.logger.log('\n✗ No valid attachments selected.\n', { type: 'error' });
      return;
    }

    // Get selected attachments
    const selectedAttachments = validIndices.map((idx) => attachments[idx - 1]);
    const fileNames = selectedAttachments.map((att) => att.fileName);

    const confirm = (
      await rl.question(
        `\n⚠️  Are you sure you want to delete ${fileNames.length} attachment(s)? This cannot be undone! (yes/no): `,
      )
    )
      .trim()
      .toLowerCase();

    if (confirm !== 'yes' && confirm !== 'y') {
      this.logger.log('\nCancelled.\n', { type: 'info' });
      return;
    }

    const result = this.attachmentManager.deleteAttachments(fileNames);

    if (result.deleted.length > 0) {
      // Remove deleted attachments from pending list
      const pendingAttachments = this.callbacks.getPendingAttachments();
      this.callbacks.setPendingAttachments(
        pendingAttachments.filter(
          (att) => !result.deleted.includes(att.fileName),
        ),
      );
    }

    if (result.failed.length > 0) {
      this.logger.log(
        `\n⚠️  Failed to delete ${result.failed.length} attachment(s): ${result.failed.join(', ')}\n`,
        { type: 'warning' },
      );
    }
  }
}
