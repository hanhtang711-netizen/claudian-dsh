import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { decompress } from 'fzstd';

import type { ChatMessage, ToolCallInfo } from '../../../core/types';
import { TOOL_TODO_WRITE } from '../../../core/tools/toolNames';

/**
 * Reads a DSH session transcript from the harness's own persistence
 * (`$DSH_HOME/sessions/<projectKey>/<sessionId>/session.jsonl.zstd`) and
 * projects its event log onto Claudian `ChatMessage`s, so a reopened dsh
 * conversation shows its history. The bridge owns the live session; this
 * store is display-only hydration.
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_TOOL_RESULT_CHARS = 8000;

/** Mirror of dsh-session-persistence-jsonl's project directory key. */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

export function resolveDshSessionsRoot(): string {
  const home = process.env.DSH_HOME || os.homedir();
  return path.join(home, '.dsh', 'sessions');
}

export function resolveDshSessionFilePath(
  vaultPath: string | null,
  sessionId: string,
): string | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  const project = vaultPath?.trim() ? vaultPath : process.cwd();
  return path.join(
    resolveDshSessionsRoot(),
    projectKey(project),
    sessionId,
    'session.jsonl.zstd',
  );
}

export async function loadDshSessionMessages(
  sessionId: string,
  options: { vaultPath?: string | null } = {},
): Promise<ChatMessage[]> {
  const filePath = resolveDshSessionFilePath(
    options.vaultPath ?? null,
    sessionId,
  );
  if (!filePath) return [];

  let compressed: Buffer;
  try {
    compressed = await fs.readFile(filePath);
  } catch {
    return [];
  }

  let text: string;
  try {
    text = Buffer.from(decompress(compressed)).toString('utf8');
  } catch {
    return [];
  }

  return parseDshSessionLog(text, sessionId);
}

/**
 * Block types that carry model thinking rather than visible reply text.
 * DSH persists the full reasoning (DeepSeek `reasoning_content`) as
 * `reasoning` content blocks inside `assistant/message`; without this
 * filter, rehydrated history would expose the raw thought text as the
 * assistant's visible message content.
 */
const REASONING_BLOCK_TYPES = new Set(['reasoning', 'thought']);

function extractText(content: unknown): string {
  return extractTextBlocks(content)
    .map((block) => block.content)
    .join('\n')
    .trim();
}

/**
 * Project DSH `reasoning` content blocks onto Claudian `thinking` content
 * blocks, so hydrated history renders them folded like the live-stream path
 * (`agent_thought_chunk` → thinking chunks) instead of exposing them.
 */
function extractThinkingBlocks(content: unknown): { type: 'thinking'; content: string }[] {
  if (!Array.isArray(content)) return [];
  const blocks: { type: 'thinking'; content: string }[] = [];
  for (const block of content as unknown[]) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (typeof record.type !== 'string' || !REASONING_BLOCK_TYPES.has(record.type)) {
      continue;
    }
    const thinking =
      typeof record.text === 'string' && record.text !== '' ? record.text
      : typeof record.content === 'string' && record.content !== '' ? record.content
      : '';
    if (thinking !== '') {
      blocks.push({ type: 'thinking', content: thinking });
    }
  }
  return blocks;
}

/**
 * Project visible reply blocks onto Claudian `text` content blocks. The
 * chat renderer draws from `contentBlocks` exclusively when the array is
 * non-empty, so the reply text must live there — exactly like the
 * live-stream path — or hydrated messages with thinking would render
 * without their body.
 */
function extractTextBlocks(content: unknown): { type: 'text'; content: string }[] {
  if (!Array.isArray(content)) return [];
  const blocks: { type: 'text'; content: string }[] = [];
  for (const block of content as unknown[]) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (typeof record.type === 'string' && REASONING_BLOCK_TYPES.has(record.type)) {
      continue;
    }
    const text =
      typeof record.text === 'string' && record.text !== '' ? record.text
      : typeof record.content === 'string' && record.content !== '' ? record.content
      : typeof record.result === 'string' && record.result !== '' ? record.result
      : '';
    if (text !== '') {
      blocks.push({ type: 'text', content: text });
    }
  }
  return blocks;
}

function parseToolInput(rawArguments: string): Record<string, unknown> {
  if (!rawArguments) return {};
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the raw-arguments wrapper.
  }
  return { arguments: rawArguments };
}

/**
 * DSH todo items carry only {content, status}; Claudian's todo parser also
 * requires a non-empty `activeForm`. Fall back to the content line.
 */
function normalizeTodoInput(input: Record<string, unknown>): Record<string, unknown> {
  const todos = input.todos;
  if (!Array.isArray(todos)) return input;
  return {
    ...input,
    todos: todos.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const record = item as Record<string, unknown>;
      if (
        typeof record.content === 'string'
        && typeof record.activeForm !== 'string'
      ) {
        return { ...record, activeForm: record.content };
      }
      return record;
    }),
  };
}

export function parseDshSessionLog(text: string, sessionId: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let currentAssistant: ChatMessage | null = null;
  const pendingCalls = new Map<string, { name: string; arguments: string }>();
  let counter = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const data = event.data;
    if (!data || typeof data !== 'object') continue;
    const record = data as Record<string, unknown>;
    const timestamp = typeof event.time === 'number' ? event.time : Date.now();

    switch (event.type) {
      case 'user/message': {
        const source = record.source;
        if (!source || typeof source !== 'object') break;
        if ((source as Record<string, unknown>).kind !== 'user') break;
        const content = extractText(record.content);
        if (content === '') break;
        currentAssistant = null;
        messages.push({
          content,
          id: `dsh-${sessionId}-${counter++}`,
          role: 'user',
          timestamp,
        });
        break;
      }
      case 'assistant/message': {
        const message = record.message;
        const contentBlocks = message && typeof message === 'object'
          ? (message as Record<string, unknown>).content
          : undefined;
        const thinkingBlocks = extractThinkingBlocks(contentBlocks);
        const textBlocks = extractTextBlocks(contentBlocks);
        const assistant: ChatMessage = {
          content: textBlocks.map((block) => block.content).join('\n').trim(),
          id: `dsh-${sessionId}-${counter++}`,
          role: 'assistant',
          timestamp,
          ...(thinkingBlocks.length > 0 || textBlocks.length > 0
            ? { contentBlocks: [...thinkingBlocks, ...textBlocks] }
            : {}),
        };
        messages.push(assistant);
        currentAssistant = assistant;
        break;
      }
      case 'tool/call': {
        const callId = String(record.callId ?? '');
        if (callId === '') break;
        pendingCalls.set(callId, {
          arguments: typeof record.arguments === 'string' ? record.arguments : '',
          name: String(record.name ?? ''),
        });
        break;
      }
      case 'tool/result': {
        const message = record.message;
        const source = message && typeof message === 'object'
          ? (message as Record<string, unknown>).source
          : undefined;
        const callId = String(
          source && typeof source === 'object'
            ? (source as Record<string, unknown>).callId ?? ''
            : '',
        );
        const call = pendingCalls.get(callId);
        if (call && currentAssistant) {
          const result = extractText(
            message && typeof message === 'object'
              ? (message as Record<string, unknown>).content
              : undefined,
          );
          const isTodoWrite = call.name === 'todo_write';
          const toolCall: ToolCallInfo = {
            id: callId,
            input: isTodoWrite
              ? normalizeTodoInput(parseToolInput(call.arguments))
              : parseToolInput(call.arguments),
            name: isTodoWrite ? TOOL_TODO_WRITE : call.name,
            status: record.error ? 'error' : 'completed',
            ...(result !== '' ? { result: result.slice(0, MAX_TOOL_RESULT_CHARS) } : {}),
          };
          currentAssistant.toolCalls = currentAssistant.toolCalls ?? [];
          currentAssistant.toolCalls.push(toolCall);
        }
        pendingCalls.delete(callId);
        break;
      }
      default:
        break;
    }
  }

  return messages;
}
