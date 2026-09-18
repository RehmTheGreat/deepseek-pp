import type { ToolDescriptor } from '../types';
import {
  createToolInvocationCatalog,
  getToolCloseTag,
  getToolOpenTag,
} from '../tool';
import {
  findFirstXmlToolTag,
  getPartialXmlToolTagTailLength,
} from '../tool/xml-tags';
import { findDsmlTag, getDsmlShapeTailLength } from './dsml-delimiters';

export interface StreamingToolTextAccumulator {
  append(chunk: string): string;
  flush(): string;
  getVisibleText(): string;
}

export function createStreamingToolTextAccumulator(
  descriptors: readonly ToolDescriptor[],
): StreamingToolTextAccumulator {
  const catalog = createToolInvocationCatalog(descriptors);
  return new ToolTextAccumulator(catalog.invocationNames);
}

/**
 * Live visible-text suppression: recognized tool-call bytes NEVER render as
 * prose. XML tool tags use the exact catalog tags; DSML blocks are detected
 * in EVERY delimiter shape through the shared generalized scanner (pc
 * directive 1: both wrapper names, wrapperless invokes, 1..8 bars per side,
 * whitespace-tolerant tags, any-shape closers). An unclosed DSML block at
 * flush is DROPPED, never released.
 */
class ToolTextAccumulator implements StreamingToolTextAccumulator {
  private readonly xmlTargets = new Map<string, { key: string; openTag: string; closeTag: string }>();
  private readonly xmlTargetNames: ReadonlySet<string>;
  private state: 'NORMAL' | 'SUPPRESSING' = 'NORMAL';
  private currentTarget: { key: string; name?: string; dsmlName?: string } | null = null;
  private pendingNormal = '';
  private pendingSuppressed = '';
  private visibleText = '';

  constructor(invocationNames: readonly string[]) {
    for (const tool of invocationNames) {
      this.xmlTargets.set(tool, {
        key: `xml:${tool}`,
        openTag: getToolOpenTag(tool),
        closeTag: getToolCloseTag(tool),
      });
    }
    this.xmlTargetNames = new Set(this.xmlTargets.keys());
  }

  append(chunk: string): string {
    if (!chunk) {
      this.visibleText += chunk;
      return this.visibleText;
    }

    let remaining = chunk;
    while (remaining.length > 0) {
      remaining = this.state === 'SUPPRESSING'
        ? this.consumeSuppressedText(remaining)
        : this.consumeNormalText(remaining);
    }

    return this.visibleText;
  }

  flush(): string {
    // NORMAL pending text releases as prose (a false-positive partial DSML
    // open is possible; releasing keeps flush lossless for prose). A
    // SUPPRESSING DSML block is unclosed: its pending bytes are DROPPED —
    // no DSML block may ever render as prose.
    if (this.state === 'NORMAL' && this.pendingNormal) {
      this.visibleText += this.pendingNormal;
    }

    this.state = 'NORMAL';
    this.currentTarget = null;
    this.pendingNormal = '';
    this.pendingSuppressed = '';
    return this.visibleText;
  }

  getVisibleText(): string {
    return this.visibleText;
  }

  private consumeNormalText(input: string): string {
    const text = this.pendingNormal + input;
    this.pendingNormal = '';

    const found = this.findFirstOpenTag(text);
    if (!found) {
      const xmlTailLength = getPartialXmlToolTagTailLength(text, this.xmlTargetNames, { closing: false });
      const dsmlTailLength = getDsmlShapeTailLength(text);
      const tailLength = Math.max(xmlTailLength, dsmlTailLength);
      const emitLength = text.length - tailLength;
      if (emitLength > 0) this.visibleText += text.slice(0, emitLength);
      this.pendingNormal = tailLength > 0 ? text.slice(-tailLength) : '';
      return '';
    }

    if (found.index > 0) {
      this.visibleText += text.slice(0, found.index);
    }

    this.state = 'SUPPRESSING';
    this.currentTarget = found.dsmlName
      ? { key: 'legacy:dsml-generalized', dsmlName: found.dsmlName }
      : { key: `xml:${found.name}`, name: found.name };
    this.pendingSuppressed = '';
    return text.slice(found.endIndex);
  }

  private consumeSuppressedText(input: string): string {
    const target = this.currentTarget;
    if (!target) {
      this.state = 'NORMAL';
      return input;
    }

    const text = this.pendingSuppressed + input;
    this.pendingSuppressed = '';

    if (target.dsmlName) {
      // Generalized close: first closing tag of the SAME name, ANY bar shape.
      const close = findDsmlTag(
        text,
        0,
        (tag) => tag.closing && tag.name === target.dsmlName,
      );
      if (!close) {
        const tailLength = getDsmlShapeTailLength(text);
        this.pendingSuppressed = tailLength > 0 ? text.slice(-tailLength) : '';
        return '';
      }
      this.state = 'NORMAL';
      this.currentTarget = null;
      return text.slice(close.endIndex);
    }

    const closeMatch = findFirstXmlToolTag(text, new Set([target.name!]), { closing: true });
    if (!closeMatch) {
      const tailLength = getPartialXmlToolTagTailLength(text, new Set([target.name!]), { closing: true });
      this.pendingSuppressed = tailLength > 0 ? text.slice(-tailLength) : '';
      return '';
    }

    this.state = 'NORMAL';
    this.currentTarget = null;
    return text.slice(closeMatch.endIndex);
  }

  private findFirstOpenTag(text: string): {
    index: number;
    endIndex: number;
    name?: string;
    dsmlName?: string;
  } | null {
    const xmlMatch = findFirstXmlToolTag(text, this.xmlTargetNames, { closing: false });
    const dsmlMatch = findDsmlTag(
      text,
      0,
      (tag) => !tag.closing && (tag.name === 'tool_calls' || tag.name === 'calls' || tag.name === 'invoke'),
    );
    if (xmlMatch && (!dsmlMatch || xmlMatch.index <= dsmlMatch.index)) {
      return { index: xmlMatch.index, endIndex: xmlMatch.endIndex, name: xmlMatch.name };
    }
    if (dsmlMatch) {
      return { index: dsmlMatch.index, endIndex: dsmlMatch.endIndex, dsmlName: dsmlMatch.name };
    }
    return null;
  }
}
