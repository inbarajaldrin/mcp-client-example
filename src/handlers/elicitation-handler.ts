import readline from 'readline/promises';
import { Logger } from '../logger.js';
import { AbstractHandler } from './base-handler.js';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

/** Minimal interface for elicitation logging — avoids circular import of ChatHistoryManager */
interface ElicitationChatLogger {
  addElicitationEvent(
    action: 'accept' | 'decline' | 'cancel' | 'auto-decline' | 'auto-decline-cancelled',
    serverMessage?: string,
    reason?: string,
  ): void;
}

// Field schema types from MCP spec
interface StringEnumField {
  type: 'string';
  title?: string;
  description?: string;
  enum: string[];
  enumNames?: string[];
  default?: string;
}

interface StringOneOfField {
  type: 'string';
  title?: string;
  description?: string;
  oneOf: Array<{ const: string; title: string }>;
  default?: string;
}

interface StringField {
  type: 'string';
  title?: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  format?: 'date' | 'uri' | 'email' | 'date-time';
  default?: string;
}

interface NumberField {
  type: 'number' | 'integer';
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  default?: number;
}

interface BooleanField {
  type: 'boolean';
  title?: string;
  description?: string;
  default?: boolean;
}

interface ArrayEnumField {
  type: 'array';
  title?: string;
  description?: string;
  minItems?: number;
  maxItems?: number;
  items: { type: 'string'; enum: string[] } | { anyOf: Array<{ const: string; title: string }> };
  default?: string[];
}

type FieldSchema = StringEnumField | StringOneOfField | StringField | NumberField | BooleanField | ArrayEnumField;

interface ElicitationSchema {
  type: 'object';
  properties: Record<string, FieldSchema>;
  required?: string[];
}

export class ElicitationHandler extends AbstractHandler {
  private createReadline: () => readline.Interface;
  private externalReadline: readline.Interface | null = null;
  private onElicitationStart: (() => void) | null = null;
  private onElicitationEnd: (() => void) | null = null;
  private pendingAbortController: AbortController | null = null;
  private _autoDecline: boolean = false;
  private chatLogger?: ElicitationChatLogger;

  constructor(logger: Logger, createReadline: () => readline.Interface) {
    super(logger);
    this.createReadline = createReadline;
  }

  /** Set the chat history logger for recording elicitation events */
  setChatLogger(chatLogger: ElicitationChatLogger): void {
    this.chatLogger = chatLogger;
  }

  /**
   * No setup needed for elicitation handler.
   */
  setup(): void {
    // Elicitation handler doesn't need setup - it's request-driven
  }

  /**
   * No cleanup needed for elicitation handler.
   */
  cleanup(): void {
    // Elicitation handler doesn't need cleanup
  }

  /**
   * Set an external readline interface to use instead of creating a new one.
   * This prevents double input capture when CLI already has a readline active.
   */
  setExternalReadline(rl: readline.Interface | null): void {
    this.externalReadline = rl;
  }

  /**
   * Set callbacks for elicitation start/end events.
   * Used to pause keyboard monitoring during elicitation.
   */
  setElicitationCallbacks(onStart: () => void, onEnd: () => void): void {
    this.onElicitationStart = onStart;
    this.onElicitationEnd = onEnd;
  }

  /**
   * Set auto-decline mode. When true, any incoming elicitation is
   * immediately declined without prompting the user. Used when
   * whenInput hooks have already triggered @complete-phase.
   */
  setAutoDecline(value: boolean): void {
    this._autoDecline = value;
  }

  /**
   * Cancel any pending elicitation prompt (auto-declines).
   * Called when a tool execution times out or a phase ends, preventing
   * dangling readline prompts from leaking into subsequent output.
   */
  cancelPending(): void {
    if (this.pendingAbortController) {
      this.pendingAbortController.abort();
      this.pendingAbortController = null;
    }
  }

  async handleElicitation(request: ElicitRequest): Promise<ElicitResult> {
    // Auto-decline when a whenInput hook already triggered @complete-phase
    if (this._autoDecline) {
      this.logger.log(`\n[Elicitation auto-declined — phase already complete]\n`, { type: 'info' });
      const msg = (request.params as any).message;
      this.chatLogger?.addElicitationEvent('auto-decline', msg, 'phase already complete');
      return { action: 'decline' };
    }

    const params = request.params;

    // Check if this is a URL elicitation (not supported in this implementation)
    if ('url' in params && params.url) {
      this.logger.log(`\n[Server Request] URL elicitation not supported\n`, { type: 'warning' });
      this.chatLogger?.addElicitationEvent('decline', undefined, 'URL elicitation not supported');
      return { action: 'decline' };
    }

    // Form elicitation
    const { message, requestedSchema } = params as { message: string; requestedSchema: ElicitationSchema };

    this.logger.log(`\n${'─'.repeat(60)}\n`, { type: 'info' });
    this.logger.log(`[Server Request]\n`, { type: 'info' });
    this.logger.log(`${message}\n\n`, { type: 'info' });

    // Notify that elicitation is starting (pauses keyboard monitoring)
    // Must happen BEFORE getting readline reference since stopKeyboardMonitoring recreates it
    this.onElicitationStart?.();

    // Create abort controller so this elicitation can be cancelled externally
    const ac = new AbortController();
    this.pendingAbortController = ac;

    // Use external readline if available, otherwise create a new one
    const useExternalRl = this.externalReadline !== null;
    const rl = this.externalReadline ?? this.createReadline();

    try {
      // Prompt user for action
      const action = await this.promptAction(rl, ac.signal);
      if (action !== 'accept') {
        this.chatLogger?.addElicitationEvent(action, message);
        return { action };
      }

      // Collect form data based on schema
      const content = await this.collectFormData(rl, requestedSchema, ac.signal);

      this.chatLogger?.addElicitationEvent('accept', message);
      return { action: 'accept', content };
    } catch (error: any) {
      // AbortError means the elicitation was cancelled externally (e.g., tool timeout)
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        this.logger.log(`  [Elicitation auto-declined (cancelled)]\n`, { type: 'warning' });
        this.chatLogger?.addElicitationEvent('auto-decline-cancelled', message, 'tool timeout or force stop');
        return { action: 'decline' };
      }
      throw error;
    } finally {
      this.pendingAbortController = null;
      // Only close if we created the readline (don't close external one)
      if (!useExternalRl) {
        rl.close();
      }
      this.logger.log(`${'─'.repeat(60)}\n`, { type: 'info' });
      // Notify that elicitation has ended (resumes keyboard monitoring)
      this.onElicitationEnd?.();
    }
  }

  private async promptAction(rl: readline.Interface, signal?: AbortSignal): Promise<'accept' | 'decline' | 'cancel'> {
    while (true) {
      const response = await rl.question('[A]ccept / [D]ecline / [C]ancel: ', { signal } as any);
      const normalized = response.trim().toLowerCase();

      if (normalized === 'a' || normalized === 'accept') {
        return 'accept';
      } else if (normalized === 'd' || normalized === 'decline') {
        return 'decline';
      } else if (normalized === 'c' || normalized === 'cancel') {
        return 'cancel';
      }

      this.logger.log('Please enter A, D, or C\n', { type: 'warning' });
    }
  }

  private async collectFormData(
    rl: readline.Interface,
    schema: ElicitationSchema,
    signal?: AbortSignal,
  ): Promise<Record<string, string | number | boolean | string[]>> {
    const result: Record<string, string | number | boolean | string[]> = {};
    const requiredFields = new Set(schema.required || []);

    this.logger.log('\nPlease provide the requested information:\n\n', { type: 'info' });

    for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
      const isRequired = requiredFields.has(fieldName);
      const value = await this.promptField(rl, fieldName, fieldSchema, isRequired);

      if (value !== undefined) {
        result[fieldName] = value;
      }
    }

    return result;
  }

  private async promptField(
    rl: readline.Interface,
    fieldName: string,
    schema: FieldSchema,
    isRequired: boolean,
  ): Promise<string | number | boolean | string[] | undefined> {
    const title = schema.title || fieldName;
    const description = schema.description;
    const requiredMarker = isRequired ? ' *' : '';

    // Display field info
    this.logger.log(`${title}${requiredMarker}`, { type: 'info' });
    if (description) {
      this.logger.log(` (${description})`, { type: 'info' });
    }
    this.logger.log('\n', { type: 'info' });

    // Handle based on field type
    if (schema.type === 'boolean') {
      return this.promptBoolean(rl, schema.default);
    } else if (schema.type === 'number' || schema.type === 'integer') {
      return this.promptNumber(rl, schema, isRequired);
    } else if (schema.type === 'array') {
      return this.promptArray(rl, schema, isRequired);
    } else if (schema.type === 'string') {
      // Check for enum or oneOf
      if ('enum' in schema && schema.enum) {
        return this.promptStringEnum(rl, schema, isRequired);
      } else if ('oneOf' in schema && schema.oneOf) {
        return this.promptStringOneOf(rl, schema, isRequired);
      } else {
        return this.promptString(rl, schema, isRequired);
      }
    }

    return undefined;
  }

  private async promptBoolean(rl: readline.Interface, defaultValue?: boolean): Promise<boolean> {
    const defaultStr = defaultValue !== undefined ? (defaultValue ? 'Y' : 'N') : '';
    const prompt = defaultStr ? `  [y/n] (default: ${defaultStr}): ` : '  [y/n]: ';

    while (true) {
      const response = await rl.question(prompt);
      const normalized = response.trim().toLowerCase();

      if (normalized === '' && defaultValue !== undefined) {
        return defaultValue;
      } else if (normalized === 'y' || normalized === 'yes' || normalized === 'true') {
        return true;
      } else if (normalized === 'n' || normalized === 'no' || normalized === 'false') {
        return false;
      }

      this.logger.log('  Please enter y or n\n', { type: 'warning' });
    }
  }

  private async promptNumber(
    rl: readline.Interface,
    schema: NumberField,
    isRequired: boolean,
  ): Promise<number | undefined> {
    const { minimum, maximum, default: defaultValue } = schema;
    const isInteger = schema.type === 'integer';

    let prompt = '  ';
    if (minimum !== undefined && maximum !== undefined) {
      prompt += `[${minimum}-${maximum}]`;
    } else if (minimum !== undefined) {
      prompt += `[>=${minimum}]`;
    } else if (maximum !== undefined) {
      prompt += `[<=${maximum}]`;
    }
    if (defaultValue !== undefined) {
      prompt += ` (default: ${defaultValue})`;
    }
    prompt += ': ';

    while (true) {
      const response = await rl.question(prompt);
      const trimmed = response.trim();

      if (trimmed === '') {
        if (defaultValue !== undefined) {
          return defaultValue;
        } else if (!isRequired) {
          return undefined;
        }
        this.logger.log('  This field is required\n', { type: 'warning' });
        continue;
      }

      const num = isInteger ? parseInt(trimmed, 10) : parseFloat(trimmed);

      if (isNaN(num)) {
        this.logger.log('  Please enter a valid number\n', { type: 'warning' });
        continue;
      }

      if (isInteger && !Number.isInteger(num)) {
        this.logger.log('  Please enter an integer\n', { type: 'warning' });
        continue;
      }

      if (minimum !== undefined && num < minimum) {
        this.logger.log(`  Value must be >= ${minimum}\n`, { type: 'warning' });
        continue;
      }

      if (maximum !== undefined && num > maximum) {
        this.logger.log(`  Value must be <= ${maximum}\n`, { type: 'warning' });
        continue;
      }

      return num;
    }
  }

  private async promptString(
    rl: readline.Interface,
    schema: StringField,
    isRequired: boolean,
  ): Promise<string | undefined> {
    const { minLength, maxLength, format, default: defaultValue } = schema;

    let prompt = '  ';
    if (format) {
      prompt += `[${format}] `;
    }
    if (defaultValue) {
      prompt += `(default: ${defaultValue}) `;
    }
    prompt += ': ';

    while (true) {
      const response = await rl.question(prompt);
      const trimmed = response.trim();

      if (trimmed === '') {
        if (defaultValue !== undefined) {
          return defaultValue;
        } else if (!isRequired) {
          return undefined;
        }
        this.logger.log('  This field is required\n', { type: 'warning' });
        continue;
      }

      // Validate length
      if (minLength !== undefined && trimmed.length < minLength) {
        this.logger.log(`  Value must be at least ${minLength} characters\n`, { type: 'warning' });
        continue;
      }

      if (maxLength !== undefined && trimmed.length > maxLength) {
        this.logger.log(`  Value must be at most ${maxLength} characters\n`, { type: 'warning' });
        continue;
      }

      // Validate format
      if (format && !this.validateFormat(trimmed, format)) {
        this.logger.log(`  Please enter a valid ${format}\n`, { type: 'warning' });
        continue;
      }

      return trimmed;
    }
  }

  private validateFormat(value: string, format: string): boolean {
    switch (format) {
      case 'email':
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      case 'uri':
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      case 'date':
        return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
      case 'date-time':
        return !isNaN(Date.parse(value));
      default:
        return true;
    }
  }

  private async promptStringEnum(
    rl: readline.Interface,
    schema: StringEnumField,
    isRequired: boolean,
  ): Promise<string | undefined> {
    const { enum: options, enumNames, default: defaultValue } = schema;

    // Display options
    this.logger.log('  Options:\n', { type: 'info' });
    options.forEach((opt, idx) => {
      const displayName = enumNames?.[idx] || opt;
      const defaultMarker = opt === defaultValue ? ' (default)' : '';
      this.logger.log(`    ${idx + 1}. ${displayName}${defaultMarker}\n`, { type: 'info' });
    });

    while (true) {
      const response = await rl.question('  Select (number or value): ');
      const trimmed = response.trim();

      if (trimmed === '') {
        if (defaultValue !== undefined) {
          return defaultValue;
        } else if (!isRequired) {
          return undefined;
        }
        this.logger.log('  This field is required\n', { type: 'warning' });
        continue;
      }

      // Try as number
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        return options[num - 1];
      }

      // Try as exact value
      if (options.includes(trimmed)) {
        return trimmed;
      }

      this.logger.log(`  Please select a valid option (1-${options.length})\n`, { type: 'warning' });
    }
  }

  private async promptStringOneOf(
    rl: readline.Interface,
    schema: StringOneOfField,
    isRequired: boolean,
  ): Promise<string | undefined> {
    const { oneOf, default: defaultValue } = schema;

    // Display options
    this.logger.log('  Options:\n', { type: 'info' });
    oneOf.forEach((opt, idx) => {
      const defaultMarker = opt.const === defaultValue ? ' (default)' : '';
      this.logger.log(`    ${idx + 1}. ${opt.title}${defaultMarker}\n`, { type: 'info' });
    });

    while (true) {
      const response = await rl.question('  Select (number): ');
      const trimmed = response.trim();

      if (trimmed === '') {
        if (defaultValue !== undefined) {
          return defaultValue;
        } else if (!isRequired) {
          return undefined;
        }
        this.logger.log('  This field is required\n', { type: 'warning' });
        continue;
      }

      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= oneOf.length) {
        return oneOf[num - 1].const;
      }

      this.logger.log(`  Please select a valid option (1-${oneOf.length})\n`, { type: 'warning' });
    }
  }

  private async promptArray(
    rl: readline.Interface,
    schema: ArrayEnumField,
    isRequired: boolean,
  ): Promise<string[] | undefined> {
    const { items, minItems, maxItems, default: defaultValue } = schema;

    // Get options from items
    let options: Array<{ value: string; title: string }>;

    if ('enum' in items) {
      options = items.enum.map(v => ({ value: v, title: v }));
    } else if ('anyOf' in items) {
      options = items.anyOf.map(o => ({ value: o.const, title: o.title }));
    } else {
      return undefined;
    }

    // Display options
    this.logger.log('  Select multiple (comma-separated numbers):\n', { type: 'info' });
    options.forEach((opt, idx) => {
      const isDefault = defaultValue?.includes(opt.value);
      const defaultMarker = isDefault ? ' (default)' : '';
      this.logger.log(`    ${idx + 1}. ${opt.title}${defaultMarker}\n`, { type: 'info' });
    });

    if (minItems !== undefined || maxItems !== undefined) {
      const constraints: string[] = [];
      if (minItems !== undefined) constraints.push(`min: ${minItems}`);
      if (maxItems !== undefined) constraints.push(`max: ${maxItems}`);
      this.logger.log(`  (${constraints.join(', ')})\n`, { type: 'info' });
    }

    while (true) {
      const response = await rl.question('  Select: ');
      const trimmed = response.trim();

      if (trimmed === '') {
        if (defaultValue !== undefined) {
          return defaultValue;
        } else if (!isRequired) {
          return undefined;
        }
        this.logger.log('  This field is required\n', { type: 'warning' });
        continue;
      }

      // Parse comma-separated numbers
      const parts = trimmed.split(',').map(s => s.trim());
      const selected: string[] = [];
      let valid = true;

      for (const part of parts) {
        const num = parseInt(part, 10);
        if (isNaN(num) || num < 1 || num > options.length) {
          this.logger.log(`  Invalid selection: ${part}\n`, { type: 'warning' });
          valid = false;
          break;
        }
        selected.push(options[num - 1].value);
      }

      if (!valid) continue;

      // Validate count constraints
      if (minItems !== undefined && selected.length < minItems) {
        this.logger.log(`  Please select at least ${minItems} item(s)\n`, { type: 'warning' });
        continue;
      }

      if (maxItems !== undefined && selected.length > maxItems) {
        this.logger.log(`  Please select at most ${maxItems} item(s)\n`, { type: 'warning' });
        continue;
      }

      return selected;
    }
  }
}
