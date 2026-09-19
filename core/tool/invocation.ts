import { DEFAULT_LOCALE, type SupportedLocale } from '../i18n/background';
import { createMemoryToolDescriptors } from './memory';
import { createWebSearchToolDescriptors } from './web-search';
import type { ToolCall, ToolDescriptor, ToolError, ToolPayload } from './types';
import { findFirstXmlToolTag } from './xml-tags';

export function createDefaultToolDescriptors(
  locale: SupportedLocale = DEFAULT_LOCALE,
): readonly ToolDescriptor[] {
  return [
    ...createMemoryToolDescriptors(locale),
    ...createWebSearchToolDescriptors(locale),
  ];
}

export const DEFAULT_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = createDefaultToolDescriptors(DEFAULT_LOCALE);

export interface ToolInvocationCatalog {
  descriptors: readonly ToolDescriptor[];
  invocationNames: string[];
  descriptorByInvocationName: Map<string, ToolDescriptor>;
  descriptorByName: Map<string, ToolDescriptor>;
  invocationNamesByDescriptorId: Map<string, string[]>;
  /**
   * The full tool-TAG scan set: every advertised invocation name plus every
   * advertised descriptor name (fix round 4, D2). Models shorten
   * `mcp_t_<server>_tool_list` to `<tool_list>`; ONE shared scanner truth
   * must claim those bytes on every surface (loop parser, page filter,
   * display/history strip) so a tool call can never render as plain text.
   * Resolution stays exact: `resolveToolTagName` (core/tool/tag-variants.ts)
   * binds an unambiguous short name to its descriptor and reports ambiguous
   * ones as a structured error instead of guessing a server.
   */
  toolTagNames: string[];
  /** All descriptors per plain descriptor name (variant resolution). */
  descriptorsByName: Map<string, ToolDescriptor[]>;
}

export interface ToolParsingInput {
  descriptors?: readonly ToolDescriptor[];
}

const catalogCache = new WeakMap<readonly ToolDescriptor[], ToolInvocationCatalog>();
const xmlRegexSourceCache = new WeakMap<ToolInvocationCatalog, string>();

export function createToolInvocationCatalog(
  descriptors: readonly ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS,
): ToolInvocationCatalog {
  const cached = catalogCache.get(descriptors);
  if (cached) return cached;

  const descriptorByInvocationName = new Map<string, ToolDescriptor>();
  const descriptorByName = new Map<string, ToolDescriptor>();
  const invocationNamesByDescriptorId = new Map<string, string[]>();
  const toolNameCounts = new Map<string, number>();
  const descriptorsByName = new Map<string, ToolDescriptor[]>();

  for (const descriptor of descriptors) {
    const name = descriptor.name.trim();
    if (!isValidToolTagName(name)) continue;
    toolNameCounts.set(name, (toolNameCounts.get(name) ?? 0) + 1);
    const named = descriptorsByName.get(name);
    if (named) {
      if (!named.includes(descriptor)) named.push(descriptor);
    } else {
      descriptorsByName.set(name, [descriptor]);
    }
  }

  for (const descriptor of descriptors) {
    const invocationName = descriptor.invocationName.trim();
    const acceptedNames: string[] = [];
    if (isValidToolTagName(invocationName)) {
      addInvocationName(descriptorByInvocationName, acceptedNames, invocationName, descriptor);
    }

    const name = descriptor.name.trim();
    if (name && !descriptorByName.has(name)) {
      descriptorByName.set(name, descriptor);
    }

    if (
      name &&
      name !== invocationName &&
      isValidToolTagName(name) &&
      toolNameCounts.get(name) === 1
    ) {
      addInvocationName(descriptorByInvocationName, acceptedNames, name, descriptor);
    }

    invocationNamesByDescriptorId.set(descriptor.id, acceptedNames);
  }

  const catalog: ToolInvocationCatalog = {
    descriptors,
    invocationNames: [...descriptorByInvocationName.keys()],
    descriptorByInvocationName,
    descriptorByName,
    invocationNamesByDescriptorId,
    toolTagNames: [
      ...descriptorByInvocationName.keys(),
      ...[...descriptorsByName.keys()].filter(
        (name) => !descriptorByInvocationName.has(name),
      ),
    ],
    descriptorsByName,
  };
  catalogCache.set(descriptors, catalog);
  return catalog;
}

export function createXmlToolCallRegex(catalog: ToolInvocationCatalog): RegExp {
  if (catalog.invocationNames.length === 0) return /$a/g;
  let source = xmlRegexSourceCache.get(catalog);
  if (!source) {
    const names = catalog.invocationNames.map(escapeRegExp).join('|');
    source = `<\\s*(${names})\\s*>\\s*([\\s\\S]*?)\\s*<\\/\\s*\\1\\s*>`;
    xmlRegexSourceCache.set(catalog, source);
  }
  return new RegExp(source, 'g');
}

export function createToolCallFromInvocation(
  invocationName: string,
  payload: ToolPayload,
  raw: string,
  catalog: ToolInvocationCatalog,
  options?: { parseError?: ToolError; id?: string; localSkillDir?: string },
): ToolCall {
  const descriptor =
    catalog.descriptorByInvocationName.get(invocationName) ||
    catalog.descriptorByName.get(invocationName);

  const call: ToolCall = {
    name: descriptor?.name ?? invocationName,
    invocationName: descriptor?.invocationName ?? invocationName,
    payload,
    raw,
    descriptorId: descriptor?.id,
    provider: descriptor?.provider,
    parseError: options?.parseError,
  };
  if (options?.id) call.id = options.id;
  // localSkillDir is only a trusted internal injection point for the "request-
  // level cwd hint": its source is the parser's activeLocalSkillDir (upstream
  // requestContext.activeLocalSkillDir, injected by content.ts's augment result
  // via fetch-hook, NOT the page/model message body). The untrusted page field
  // is stripped at runtime.ts:resolveToolCallPayload (Review #2).
  if (options?.localSkillDir) call.localSkillDir = options.localSkillDir;
  return call;
}

export function getToolInvocationNames(
  descriptor: ToolDescriptor,
  catalog: ToolInvocationCatalog = createToolInvocationCatalog([descriptor]),
): string[] {
  const names = catalog.invocationNamesByDescriptorId.get(descriptor.id);
  if (names?.length) return names;
  return descriptor.invocationName ? [descriptor.invocationName] : [];
}

export function getPreferredToolInvocationName(
  descriptor: ToolDescriptor,
  catalog: ToolInvocationCatalog = createToolInvocationCatalog([descriptor]),
): string {
  const names = getToolInvocationNames(descriptor, catalog);
  const directName = descriptor.name.trim();
  if (directName && names.includes(directName)) return directName;
  return names[0] ?? descriptor.invocationName;
}

export function getToolInvocationLabel(
  name: string,
  catalog: ToolInvocationCatalog = createToolInvocationCatalog(),
): string {
  const descriptor =
    catalog.descriptorByInvocationName.get(name) ||
    catalog.descriptorByName.get(name);
  return descriptor?.title || name;
}

export function getToolOpenTag(invocationName: string): string {
  return `<${invocationName}>`;
}

export function getToolCloseTag(invocationName: string): string {
  return `</${invocationName}>`;
}

export function hasXmlToolMarker(text: string, catalog: ToolInvocationCatalog): boolean {
  const names = new Set(catalog.toolTagNames);
  return Boolean(
    findFirstXmlToolTag(text, names, { closing: false }) ||
    findFirstXmlToolTag(text, names, { closing: true }),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addInvocationName(
  descriptorByInvocationName: Map<string, ToolDescriptor>,
  acceptedNames: string[],
  invocationName: string,
  descriptor: ToolDescriptor,
) {
  acceptedNames.push(invocationName);
  if (descriptorByInvocationName.has(invocationName)) return;
  descriptorByInvocationName.set(invocationName, descriptor);
}

function isValidToolTagName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value);
}
