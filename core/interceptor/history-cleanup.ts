import { DPP_MANAGED_AGENT_PROMPT_MARKER } from '../constants';
import {
  INLINE_AGENT_CONTINUATION_PLACEHOLDER,
  isInlineAgentContinuationPrompt,
  replaceTaskCompleteBlocks,
} from '../inline-agent/prompt';
import { sanitizeInternalPromptText } from '../prompt';
import { normalizeInlineAgentNativeMarkdown } from '../inline-agent/native-markdown';
import type { ToolCall, ToolCallRestoreRecord, ToolDescriptor } from '../types';
import {
  createToolCallFromInvocation,
  createToolInvocationCatalog,
  getToolCloseTag,
  getToolOpenTag,
  hasXmlToolMarker,
  type ToolInvocationCatalog,
} from '../tool';
import { findFirstXmlToolTag } from '../tool/xml-tags';
import { extractToolCalls } from './tool-parser';
import { withInlineAgentSpawnDisplayDescriptor } from '../inline-agent/subagent-tool';
import { findDsmlTag, findNextDsmlToolBlock } from './dsml-delimiters';

const RESTORE_FULL_PARSE_MAX_LENGTH = 120_000;
const RESTORE_CONTENT_MAX_LENGTH = 8000;
const RESTORE_RAW_MAX_LENGTH = 512;
const RESTORE_PAYLOAD_STRING_MAX_LENGTH = 2048;
const RESTORE_PAYLOAD_STRING_PREVIEW_LENGTH = 240;
const RESTORE_PAYLOAD_ARRAY_MAX_ITEMS = 20;
const RESTORE_PAYLOAD_OBJECT_MAX_KEYS = 40;
const RESTORE_PAYLOAD_MAX_DEPTH = 6;
const RESTORE_OMITTED_PAYLOAD_RAW = '...[restore payload omitted]';

interface LightweightToolBlock {
  start: number;
  end: number;
  invocationNames: string[];
  complete: boolean;
}

export interface HistoryCleanupOptions {
  toolDescriptors: readonly ToolDescriptor[];
  onToolCallsRestored: (records: ToolCallRestoreRecord[]) => void;
}

export function stripToolCallsFromHistory(json: any, options: HistoryCleanupOptions) {
  if (!json || !json.data) return;
  const data = json.data.biz_data || json.data;
  const messages = data.chat_messages;
  if (!Array.isArray(messages)) return;

  const restoredRecords: ToolCallRestoreRecord[] = [];
  stripMessageToolCalls(messages, restoredRecords, options.toolDescriptors);

  if (restoredRecords.length > 0) {
    options.onToolCallsRestored(restoredRecords);
  }
}

export function stripToolCallsFromIDBResult(result: any, options: HistoryCleanupOptions) {
  const restoredRecords: ToolCallRestoreRecord[] = [];

  if (Array.isArray(result)) {
    for (const item of result) {
      stripSingleIDBRecord(item, restoredRecords, options.toolDescriptors);
    }
  } else {
    stripSingleIDBRecord(result, restoredRecords, options.toolDescriptors);
  }

  if (restoredRecords.length > 0) {
    options.onToolCallsRestored(restoredRecords);
  }
}

function stripSingleIDBRecord(
  record: any,
  restoredRecords: ToolCallRestoreRecord[],
  toolDescriptors: readonly ToolDescriptor[],
) {
  if (!record || !record.data) return;
  const data = record.data;
  const messages = data.chat_messages;
  if (!Array.isArray(messages)) return;

  stripMessageToolCalls(messages, restoredRecords, toolDescriptors);
}

function stripMessageToolCalls(
  messages: any[],
  restoredRecords: ToolCallRestoreRecord[],
  toolDescriptors: readonly ToolDescriptor[],
) {
  // Display-strip recognition covers every ADVERTISED tool: the shared
  // catalog never carries subagent_spawn (spawn-free source composition), but
  // native turns advertise and execute it through merged grants, so restored
  // history must strip it too (Defect 3, 2026-09-18). Strip symmetry:
  // recognize == strip, nothing else is removed.
  const stripDescriptors = withInlineAgentSpawnDisplayDescriptor(toolDescriptors);
  const visibleMessages = messages.filter((msg: any) => !isRemovableInternalManagedAgentMessage(msg));
  if (visibleMessages.length !== messages.length) {
    messages.splice(0, messages.length, ...visibleMessages);
  }

  let assistantMessageIndex = 0;
  const inlineAgentContinuationMessageIds = collectInlineAgentContinuationMessageIds(visibleMessages);
  visibleMessages.forEach((msg: any, index: number) => {
    const replaceTaskComplete = shouldReplaceStoredTaskCompleteBlocks(msg, inlineAgentContinuationMessageIds);
    const shouldRestoreToolCalls = !replaceTaskComplete;
    sanitizeInlineAgentContinuationMessage(msg);
    sanitizeStoredMessageInternalPrompt(msg, { replaceTaskComplete });
    const hasStoredToolCall = storedMessageHasToolCallMarker(msg, stripDescriptors);
    const isAssistant = isAssistantStoredMessage(msg) || hasStoredToolCall;
    const currentAssistantMessageIndex = isAssistant ? assistantMessageIndex++ : null;
    const metadata = createMessageRestoreMetadata(msg, index, currentAssistantMessageIndex);
    const messageKey = getMessageRestoreKey(msg, index);
    if (typeof msg.content === 'string' && hasToolCallMarker(msg.content, stripDescriptors)) {
      if (shouldRestoreToolCalls) {
        const record = collectToolCallRestoreRecord(msg.content, `${messageKey}:content`, toolDescriptors, metadata);
        if (record) restoredRecords.push(record);
      }
      msg.content = stripToolCallsForHistoryText(msg.content, stripDescriptors);
    }
    stripFragmentToolCalls(
      msg.fragments,
      messageKey,
      restoredRecords,
      stripDescriptors,
      metadata,
      shouldRestoreToolCalls,
    );
  });
}

function hasToolCallMarker(text: string, toolDescriptors: readonly ToolDescriptor[]): boolean {
  if (!text.includes('<')) return false;
  if (text.includes('｜DSML｜')) return true;
  const catalog = createToolInvocationCatalog(toolDescriptors);
  return hasXmlToolMarker(text, catalog);
}

function stripFragmentToolCalls(
  fragments: unknown,
  messageKey: string,
  restoredRecords: ToolCallRestoreRecord[],
  toolDescriptors: readonly ToolDescriptor[],
  metadata: Record<string, unknown>,
  shouldRestoreToolCalls: boolean,
): void {
  if (!Array.isArray(fragments)) return;

  const textFragments = fragments
    .map((fragment: any, index: number) => ({ fragment, index }))
    .filter((entry): entry is { fragment: { content: string }; index: number } => (
      entry.fragment && typeof entry.fragment.content === 'string'
    ));
  if (textFragments.length === 0) return;

  const text = textFragments.map(({ fragment }) => fragment.content).join('');
  if (!hasToolCallMarker(text, toolDescriptors)) return;

  if (shouldRestoreToolCalls) {
    const firstIndex = textFragments[0].index;
    const lastIndex = textFragments[textFragments.length - 1].index;
    const key = firstIndex === lastIndex
      ? `${messageKey}:fragment:${firstIndex}`
      : `${messageKey}:fragments:${firstIndex}-${lastIndex}`;
    const record = collectToolCallRestoreRecord(text, key, toolDescriptors, metadata);
    if (record) restoredRecords.push(record);
  }

  const catalog = createToolInvocationCatalog(toolDescriptors);
  const blocks = findLightweightToolBlocks(text, catalog);
  stripToolBlocksFromFragments(text, textFragments, blocks);
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getMessageRestoreKey(msg: any, index: number): string {
  return String(msg?.id ?? msg?.message_id ?? msg?.uuid ?? msg?.parent_message_id ?? index);
}

function createMessageRestoreMetadata(
  msg: any,
  messageIndex: number,
  assistantMessageIndex: number | null,
): Record<string, unknown> {
  return {
    messageId: msg?.id ?? msg?.message_id ?? msg?.messageId ?? msg?.uuid ?? null,
    parentMessageId: msg?.parent_id ?? msg?.parent_message_id ?? msg?.parentMessageId ?? null,
    messageIndex,
    assistantMessageIndex,
    role: firstString(msg?.message_role, msg?.role, msg?.type),
  };
}

function storedMessageHasToolCallMarker(msg: any, toolDescriptors: readonly ToolDescriptor[]): boolean {
  if (typeof msg?.content === 'string' && hasToolCallMarker(msg.content, toolDescriptors)) return true;
  if (!Array.isArray(msg?.fragments)) return false;
  return msg.fragments.some((frag: any) => typeof frag?.content === 'string' && hasToolCallMarker(frag.content, toolDescriptors));
}

function collectInlineAgentContinuationMessageIds(messages: any[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (!isInlineAgentContinuationMessage(msg)) continue;
    const id = getStoredMessageId(msg);
    if (id !== null) ids.add(id);
  }
  return ids;
}

function shouldReplaceStoredTaskCompleteBlocks(msg: any, inlineAgentContinuationMessageIds: Set<string>): boolean {
  if (!isAssistantStoredMessage(msg)) return false;
  const parentId = getStoredMessageParentId(msg);
  return parentId !== null && inlineAgentContinuationMessageIds.has(parentId);
}

function isAssistantStoredMessage(msg: any): boolean {
  return firstString(msg?.message_role, msg?.role, msg?.type)?.toLowerCase() === 'assistant';
}

function getStoredMessageId(msg: any): string | null {
  return firstStoredMessageId(msg?.id, msg?.message_id, msg?.messageId, msg?.uuid);
}

function getStoredMessageParentId(msg: any): string | null {
  return firstStoredMessageId(msg?.parent_id, msg?.parent_message_id, msg?.parentMessageId);
}

function firstStoredMessageId(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function collectToolCallRestoreRecord(
  text: string,
  key: string,
  toolDescriptors: readonly ToolDescriptor[],
  metadata: Record<string, unknown>,
): ToolCallRestoreRecord | null {
  if (!hasToolCallMarker(text, toolDescriptors)) return null;

  const catalog = createToolInvocationCatalog(toolDescriptors);
  const blocks = findLightweightToolBlocks(text, catalog);
  let calls: ToolCall[];
  if (text.length > RESTORE_FULL_PARSE_MAX_LENGTH) {
    calls = createLightweightToolCalls(blocks, catalog);
  } else {
    calls = extractToolCalls(text, { descriptors: toolDescriptors });
  }
  if (calls.length === 0) return null;

  const content = stripToolBlocksFromText(text, blocks);
  const restoreCalls = calls.map(sanitizeToolCallForRestoreRecord);
  const id = hashString([
    key,
    hashString(content),
    restoreCalls.map(createToolCallRestoreSignature).join('\n'),
  ].join('\n'));
  return {
    id,
    calls: restoreCalls,
    content: clampText(content, RESTORE_CONTENT_MAX_LENGTH),
    source: 'history',
    metadata,
  };
}

function createLightweightToolCalls(
  blocks: readonly LightweightToolBlock[],
  catalog: ToolInvocationCatalog,
): ToolCall[] {
  const calls: ToolCall[] = [];

  for (const block of blocks) {
    if (!block.complete) continue;
    for (const invocationName of block.invocationNames) {
      calls.push(createToolCallFromInvocation(
        invocationName,
        {},
        createOmittedToolCallRaw(invocationName),
        catalog,
      ));
    }
  }

  return calls;
}

function stripToolCallsForHistoryText(
  text: string,
  toolDescriptors: readonly ToolDescriptor[],
): string {
  const catalog = createToolInvocationCatalog(toolDescriptors);
  const blocks = findLightweightToolBlocks(text, catalog);
  return stripToolBlocksFromText(text, blocks);
}

function stripToolBlocksFromText(
  text: string,
  blocks: readonly LightweightToolBlock[],
): string {
  if (blocks.length === 0) return text.trim();

  const parts: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    parts.push(text.slice(cursor, block.start));
    cursor = block.end;
  }
  parts.push(text.slice(cursor));

  return parts.join('').trim();
}

function stripToolBlocksFromFragments(
  text: string,
  fragments: Array<{ fragment: { content: string }; index: number }>,
  blocks: readonly LightweightToolBlock[],
): void {
  if (blocks.length === 0) return;

  let fragmentStart = 0;
  for (const { fragment } of fragments) {
    const fragmentEnd = fragmentStart + fragment.content.length;
    let cursor = fragmentStart;
    let next = '';

    for (const block of blocks) {
      if (block.end <= fragmentStart) continue;
      if (block.start >= fragmentEnd) break;

      const visibleEnd = Math.min(block.start, fragmentEnd);
      if (visibleEnd > cursor) next += text.slice(cursor, visibleEnd);
      cursor = Math.max(cursor, Math.min(block.end, fragmentEnd));
    }

    if (cursor < fragmentEnd) next += text.slice(cursor, fragmentEnd);
    fragment.content = next;
    fragmentStart = fragmentEnd;
  }

  const firstVisible = fragments.find(({ fragment }) => fragment.content.length > 0)?.fragment;
  const lastVisible = [...fragments].reverse()
    .find(({ fragment }) => fragment.content.length > 0)?.fragment;
  if (firstVisible) firstVisible.content = firstVisible.content.trimStart();
  if (lastVisible) lastVisible.content = lastVisible.content.trimEnd();
}

function findLightweightToolBlocks(
  text: string,
  catalog: ToolInvocationCatalog,
): LightweightToolBlock[] {
  const blocks = [
    ...findXmlToolBlocks(text, catalog),
    ...findLegacyToolBlocks(text, catalog),
  ].sort((a, b) => a.start - b.start || b.end - a.end);

  const nonOverlapping: LightweightToolBlock[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.start < cursor) continue;
    nonOverlapping.push(block);
    cursor = block.end;
  }

  return withOrphanClosingTagBlocks(text, nonOverlapping, catalog);
}

/**
 * Orphan closing tags (D1, 2026-09-19): a duplicated closing tag whose
 * well-formed pair was already consumed survives extraction as bare text.
 * After the paired blocks are settled, scan the residual ranges for closing
 * tags of advertised/family names and drop them the same way. They carry no
 * invocation names, so the restore-record builder skips them.
 */
function withOrphanClosingTagBlocks(
  text: string,
  accepted: LightweightToolBlock[],
  catalog: ToolInvocationCatalog,
): LightweightToolBlock[] {
  const blocks = [...accepted];
  const ranges = [...accepted].sort((a, b) => a.start - b.start);
  const insideAccepted = (start: number, end: number) =>
    ranges.some((block) => start >= block.start && end <= block.end);
  const pushOrphan = (start: number, end: number) => {
    if (insideAccepted(start, end)) return;
    blocks.push({ start, end, invocationNames: [], complete: false });
  };

  let searchFrom = 0;
  for (;;) {
    const close = findFirstXmlToolTag(text, orphanCloseNames(catalog), { closing: true, fromIndex: searchFrom });
    if (!close) break;
    pushOrphan(close.index, close.endIndex);
    searchFrom = close.endIndex;
  }

  searchFrom = 0;
  for (;;) {
    const close = findDsmlTag(
      text,
      searchFrom,
      (tag) => tag.closing && ORPHAN_CLOSE_FAMILY_NAMES.has(tag.name),
    );
    if (!close) break;
    pushOrphan(close.index, close.endIndex);
    searchFrom = close.endIndex;
  }

  return blocks.sort((a, b) => a.start - b.start || b.end - a.end);
}

const ORPHAN_CLOSE_FAMILY_NAMES = new Set(['invoke', 'tool_calls', 'calls']);

function orphanCloseNames(catalog: ToolInvocationCatalog): Set<string> {
  // Shared tag scan set (D2): variant short-name closers are junk too.
  const names = new Set(catalog.toolTagNames);
  for (const familyName of ORPHAN_CLOSE_FAMILY_NAMES) names.add(familyName);
  return names;
}

function findXmlToolBlocks(
  text: string,
  catalog: ToolInvocationCatalog,
): LightweightToolBlock[] {
  const blocks: LightweightToolBlock[] = [];
  // Shared scanner truth (D2): short descriptor-name variants are claimed
  // exactly like exact invocation-name tags (strip symmetry).
  const invocationNames = new Set(catalog.toolTagNames);
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const openTag = findFirstXmlToolTag(text, invocationNames, {
      closing: false,
      fromIndex: searchFrom,
    });
    if (!openTag) break;
    const closeTag = findFirstXmlToolTag(text, new Set([openTag.name]), {
      closing: true,
      fromIndex: openTag.endIndex,
    });

    blocks.push({
      start: openTag.index,
      end: closeTag?.endIndex ?? text.length,
      invocationNames: [openTag.name],
      complete: Boolean(closeTag),
    });
    if (!closeTag) break;
    searchFrom = closeTag.endIndex;
  }

  return blocks;
}

/**
 * DSML tool blocks (linear scan) via the shared generalized claim scanner
 * (`findNextDsmlToolBlock`, core/interceptor/dsml-delimiters.ts): both
 * wrapper names, wrapperless invoke blocks, any bar shape 1..8, tolerated
 * whitespace, closers of ANY bar shape, unclosed openers claiming to EOF -
 * mirroring the tool-parser extraction claims exactly so the history strip
 * removes exactly what the parsers recognize, no more, no less.
 */
function findLegacyToolBlocks(
  text: string,
  catalog: ToolInvocationCatalog,
): LightweightToolBlock[] {
  const blocks: LightweightToolBlock[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const block = findNextDsmlToolBlock(text, searchFrom);
    if (!block) break;
    blocks.push({
      start: block.openIndex,
      end: block.endIndex,
      invocationNames: block.closed
        ? findLegacyInvocationNames(text, block.openIndex, block.endIndex, catalog)
        : [],
      complete: block.closed,
    });
    searchFrom = block.endIndex;
  }

  return blocks;
}

function findLegacyInvocationNames(
  text: string,
  start: number,
  end: number,
  catalog: ToolInvocationCatalog,
): string[] {
  const names: string[] = [];
  let searchFrom = start;

  while (searchFrom < end) {
    // Generalized invoke scan: every delimiter shape, whitespace-tolerant
    // attribute form; the name value runs to the next double quote. No
    // payload parse - the >120K lightweight path keeps skipping extraction.
    const tag = findDsmlTag(
      text,
      searchFrom,
      (candidate) => !candidate.closing
        && candidate.name === 'invoke'
        && candidate.hasInvokeNameAttribute,
    );
    if (!tag || tag.index >= end) break;
    const nameEnd = text.indexOf('"', tag.nameValueStart);
    if (nameEnd === -1 || nameEnd > end) break;
    const invocationName = text.slice(tag.nameValueStart, nameEnd);
    if (catalog.descriptorByInvocationName.has(invocationName)) {
      names.push(invocationName);
    }
    searchFrom = Math.max(tag.endIndex, nameEnd + 1);
  }

  return names;
}

function createOmittedToolCallRaw(invocationName: string): string {
  return [
    getToolOpenTag(invocationName),
    RESTORE_OMITTED_PAYLOAD_RAW,
    getToolCloseTag(invocationName),
  ].join('\n');
}

function sanitizeToolCallForRestoreRecord(call: ToolCall): ToolCall {
  return {
    ...call,
    raw: clampText(call.raw, RESTORE_RAW_MAX_LENGTH) ?? '',
    payload: sanitizeRestorePayload(call.payload),
  };
}

function sanitizeRestorePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeRestoreValue(payload, 0);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

function sanitizeRestoreValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return sanitizeRestoreString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= RESTORE_PAYLOAD_MAX_DEPTH) return { __dppRestoreMaxDepth: true };

  if (Array.isArray(value)) {
    const items = value
      .slice(0, RESTORE_PAYLOAD_ARRAY_MAX_ITEMS)
      .map((item) => sanitizeRestoreValue(item, depth + 1));
    if (value.length <= RESTORE_PAYLOAD_ARRAY_MAX_ITEMS) return items;
    return [
      ...items,
      {
        __dppRestoreOmittedItems: value.length - RESTORE_PAYLOAD_ARRAY_MAX_ITEMS,
      },
    ];
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const keptEntries = entries
    .slice(0, RESTORE_PAYLOAD_OBJECT_MAX_KEYS)
    .map(([entryKey, entryValue]) => [entryKey, sanitizeRestoreValue(entryValue, depth + 1)]);

  if (entries.length > RESTORE_PAYLOAD_OBJECT_MAX_KEYS) {
    keptEntries.push([
      '__dppRestoreOmittedKeys',
      entries.length - RESTORE_PAYLOAD_OBJECT_MAX_KEYS,
    ]);
  }

  return Object.fromEntries(keptEntries);
}

function sanitizeRestoreString(value: string): unknown {
  if (value.length <= RESTORE_PAYLOAD_STRING_MAX_LENGTH) return value;
  return {
    __dppRestoreTruncatedText: true,
    length: value.length,
    hash: hashString(value),
    preview: value.slice(0, RESTORE_PAYLOAD_STRING_PREVIEW_LENGTH),
  };
}

function createToolCallRestoreSignature(call: ToolCall): string {
  return `${call.provider?.id ?? ''}:${call.name}:${call.invocationName ?? ''}:${JSON.stringify(call.payload)}`;
}

function clampText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

function sanitizeStoredMessageInternalPrompt(msg: any, options: { replaceTaskComplete: boolean }) {
  if (!msg || typeof msg !== 'object') return;

  if (typeof msg.content === 'string') {
    msg.content = sanitizeStoredControlText(msg.content, options);
  }

  if (!Array.isArray(msg.fragments)) return;

  const textFragments = msg.fragments
    .filter((frag: any) => frag && typeof frag.content === 'string');

  if (textFragments.length === 0) return;

  if (options.replaceTaskComplete) {
    const responseFragments = textFragments.filter(isStoredResponseFragment);
    if (responseFragments.length > 0) {
      // DeepSeek stores reasoning and final text as distinct THINK/RESPONSE
      // fragments. Native-delivery normalization may change only the final
      // response bytes (for example `xychart-beta` -> Mermaid). Never join the
      // two roles and write them back into the first THINK fragment: doing so
      // turns the deliverable into plain reasoning text and removes native
      // code/chart rendering after refresh.
      for (const fragment of textFragments) {
        if (!isStoredResponseFragment(fragment)) {
          fragment.content = sanitizeStoredControlText(fragment.content, {
            replaceTaskComplete: false,
          });
        }
      }
      sanitizeStoredFragmentGroup(responseFragments, options);
      return;
    }
  }

  // Compatibility for legacy/untyped fragment arrays whose markdown can span
  // multiple entries. These have no semantic role boundary to preserve.
  sanitizeStoredFragmentGroup(textFragments, options);
}

function isStoredResponseFragment(fragment: any): boolean {
  return typeof fragment?.type === 'string' && fragment.type.toUpperCase() === 'RESPONSE';
}

function sanitizeStoredFragmentGroup(
  fragments: Array<{ content: string }>,
  options: { replaceTaskComplete: boolean },
): void {
  const joined = fragments.map((fragment) => fragment.content).join('');
  const sanitizedJoined = sanitizeStoredControlText(joined, options);
  if (sanitizedJoined !== joined) {
    fragments.forEach((fragment, index) => {
      fragment.content = index === 0 ? sanitizedJoined : '';
    });
    return;
  }

  for (const fragment of fragments) {
    fragment.content = sanitizeStoredControlText(fragment.content, options);
  }
}

function sanitizeStoredControlText(text: string, options: { replaceTaskComplete: boolean }): string {
  const sanitized = sanitizeInternalPromptText(text);
  if (!options.replaceTaskComplete) return sanitized;

  // A web-backed inline-agent final turn is persisted by DeepSeek under the
  // internal continuation user message. Normalize direct `xychart-beta`
  // fences only in that typed RESPONSE fragment so a history reload keeps
  // the identical native Mermaid chart card. Ordinary conversation messages
  // never enter this branch and retain their original markdown bytes.
  return normalizeInlineAgentNativeMarkdown(replaceTaskCompleteBlocks(sanitized));
}

function isInternalManagedAgentMessage(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.content === 'string' && isInternalManagedAgentContent(msg.content)) return true;
  if (!Array.isArray(msg.fragments)) return false;
  return msg.fragments.some((frag: any) => typeof frag?.content === 'string' && isInternalManagedAgentContent(frag.content));
}

function isRemovableInternalManagedAgentMessage(msg: any): boolean {
  return isInternalManagedAgentMessage(msg) && !isInlineAgentContinuationMessage(msg);
}

function isInlineAgentContinuationMessage(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.content === 'string' && isInlineAgentContinuationPrompt(msg.content)) return true;
  if (!Array.isArray(msg.fragments)) return false;
  return msg.fragments.some((frag: any) => typeof frag?.content === 'string' && isInlineAgentContinuationPrompt(frag.content));
}

function sanitizeInlineAgentContinuationMessage(msg: any) {
  if (!isInlineAgentContinuationMessage(msg)) return;

  if (typeof msg.content === 'string' && isInlineAgentContinuationPrompt(msg.content)) {
    msg.content = INLINE_AGENT_CONTINUATION_PLACEHOLDER;
  }

  if (!Array.isArray(msg.fragments)) return;

  let replaced = false;
  for (const frag of msg.fragments) {
    if (!frag || typeof frag.content !== 'string' || !isInlineAgentContinuationPrompt(frag.content)) continue;
    frag.content = replaced ? '' : INLINE_AGENT_CONTINUATION_PLACEHOLDER;
    replaced = true;
  }
}

function isInternalManagedAgentContent(content: string): boolean {
  if (content.includes(DPP_MANAGED_AGENT_PROMPT_MARKER)) return true;
  if (content.includes('DeepSeek++ 托管 Agent Runner') && content.includes('<tool_results>')) return true;
  if (isInlineAgentContinuationPrompt(content)) return true;
  return content.includes('Tool call format reminder:') &&
    content.includes('Available tool tag names:') &&
    content.includes('<original_user_task>') &&
    content.includes('</original_user_task>');
}
