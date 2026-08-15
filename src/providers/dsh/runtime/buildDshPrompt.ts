import type { ChatMessage, ImageAttachment } from '../../../core/types';
import {
  appendBrowserContext,
  type BrowserSelectionContext,
} from '../../../utils/browser';
import {
  appendCanvasContext,
  type CanvasSelectionContext,
} from '../../../utils/canvas';
import {
  appendCurrentNote,
  appendCurrentNoteContent,
} from '../../../utils/context';
import {
  appendEditorContext,
  type EditorSelectionContext,
} from '../../../utils/editor';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '../../../utils/session';
import type { AcpContentBlock } from '../../acp';

export interface DshPromptRequest {
  text: string;
  images?: ImageAttachment[];
  currentNotePath?: string;
  currentNoteContent?: string;
  editorSelection?: EditorSelectionContext | null;
  browserSelection?: BrowserSelectionContext | null;
  canvasSelection?: CanvasSelectionContext | null;
  externalContextPaths?: string[];
}

export function buildDshPromptText(
  request: DshPromptRequest,
  conversationHistory: ChatMessage[] = [],
): string {
  let prompt = request.text;

  if (request.currentNotePath) {
    prompt = request.currentNoteContent === undefined
      ? appendCurrentNote(prompt, request.currentNotePath)
      : appendCurrentNoteContent(
        prompt,
        request.currentNotePath,
        request.currentNoteContent,
      );
  }

  if (request.editorSelection && request.editorSelection.mode !== 'none') {
    prompt = appendEditorContext(prompt, request.editorSelection);
  }

  if (request.browserSelection) {
    prompt = appendBrowserContext(prompt, request.browserSelection);
  }

  if (request.canvasSelection) {
    prompt = appendCanvasContext(prompt, request.canvasSelection);
  }

  if (conversationHistory.length > 0) {
    const historyContext = buildContextFromHistory(conversationHistory);
    prompt = buildPromptWithHistoryContext(
      historyContext,
      prompt,
      prompt,
      conversationHistory,
    );
  }

  return prompt;
}

export function buildDshPromptBlocks(
  request: DshPromptRequest,
  conversationHistory: ChatMessage[] = [],
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [
    { type: 'text', text: buildDshPromptText(request, conversationHistory) },
  ];

  for (const image of request.images ?? []) {
    if (!image.data) {
      continue;
    }

    blocks.push({
      data: image.data,
      mimeType: image.mediaType,
      type: 'image',
    });
  }

  return blocks;
}
