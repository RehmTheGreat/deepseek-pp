import type { ToolDescriptor } from '../types';
import { createToolInvocationCatalog } from '../tool';
import {
  findFirstXmlToolTag,
  getPartialXmlToolTagTailLength,
} from '../tool/xml-tags';

export interface ToolCallScanGate {
  shouldScanChunk(text: string): boolean;
}

export function createToolCallScanGate(
  descriptors: readonly ToolDescriptor[],
): ToolCallScanGate {
  const catalog = createToolInvocationCatalog(descriptors);
  // Shared scanner truth (D2): gate on the full tag set so variant short-name
  // chunks reach the parsers instead of being skipped upstream.
  const toolNames = new Set(catalog.toolTagNames);
  let tail = '';

  return {
    shouldScanChunk(text: string): boolean {
      if (!text || toolNames.size === 0) return false;
      const probe = tail + text;
      const tailLength = getPartialXmlToolTagTailLength(probe, toolNames, { closing: true });
      tail = tailLength > 0 ? probe.slice(-tailLength) : '';
      return Boolean(findFirstXmlToolTag(probe, toolNames, { closing: true }));
    },
  };
}
