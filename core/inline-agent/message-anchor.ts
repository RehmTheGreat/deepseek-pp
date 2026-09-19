/**
 * Assistant-message anchoring for inline-agent UI (Issue #551 follow-up).
 *
 * A fresh agent run must mount its console into the NEWEST matching assistant
 * message, and matching must look only at the message's own visible text.
 * Two failure modes are guarded here:
 *
 * 1. Extension-injected UI (agent console timeline, final-answer area) lives
 *    inside the host message, so naive `textContent` matching let a message
 *    that already hosts a console match nearly every follow-up run - the new
 *    console then mounted under the PREVIOUS run's message.
 * 2. First-match-wins scanning preferred the oldest message; a new run's
 *    anchor is always the most recent one.
 */

/**
 * Selector for extension-owned UI injected into assistant messages. Text
 * under these nodes is renderer output, never message content.
 */
export const EXTENSION_INJECTED_MESSAGE_UI_SELECTOR =
  '.dpp-agent-container, [data-dpp-body-text], .dpp-agent-autosave-note';

/**
 * The message's own visible text with every extension-injected UI subtree
 * excluded, so content-snippet anchoring can never be poisoned by our own
 * rendered console/answer text.
 */
export function getAssistantMessageOwnText(message: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.matches(EXTENSION_INJECTED_MESSAGE_UI_SELECTOR)) return;
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  walk(message);
  return parts.join(' ');
}

function normalizeAnchorText(value: string | undefined): string {
  // Markdown emphasis markers are stripped so RAW anchor text (as captured
  // from the model output / history) matches the RENDERED DOM text (2026-09-18
  // live finding: DeepSeek's current DOM exposes no message-id attributes, so
  // this content match is the only surviving anchor leg; backticks and
  // asterisks disappear when the site renders the markdown). Both sides are
  // normalized identically, so no false positives are introduced.
  return (value ?? '')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Find the newest assistant message whose own text contains the content
 * snippet. `usedMessages` are skipped entirely (e.g. messages already claimed
 * by a previous run's console or an earlier restored trace).
 */
export function findAssistantMessageByContentSnippet(
  messages: Element[],
  content: string,
  usedMessages: Set<Element>,
): Element | null {
  const snippet = normalizeAnchorText(content).slice(0, 100);
  if (snippet.length < 12) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (usedMessages.has(message)) continue;
    if (normalizeAnchorText(getAssistantMessageOwnText(message)).includes(snippet)) return message;
  }
  return null;
}

/**
 * True when the element or one of its descendants exposes the given DeepSeek
 * message id through a data attribute or an id suffix.
 *
 * Attribute values match only as a whole token (`value === messageId`) or as
 * a `-`/`_`-separated suffix (`...-18`). A bare `endsWith` suffix match was a
 * false-positive vector for numeric ids (looking up `34` matched `…-234` on an
 * unrelated message and could anchor a console under the wrong reply).
 */
export function elementHasMessageId(element: Element, messageId: string): boolean {
  const candidates = [
    element,
    ...Array.from(element.querySelectorAll('[data-message-id], [data-messageid], [data-id], [data-ds-message-id], [id]')),
  ];

  return candidates.some((candidate) => {
    const attributes = [
      candidate.getAttribute('data-message-id'),
      candidate.getAttribute('data-messageid'),
      candidate.getAttribute('data-id'),
      candidate.getAttribute('data-ds-message-id'),
      candidate.getAttribute('id'),
    ];
    const suffixPattern = new RegExp(
      `(?:^|[-_])${escapeRegExp(messageId)}$`,
    );
    return attributes.some((value) => value === messageId || (value !== null && suffixPattern.test(value)));
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface InlineAgentRestoreAnchor {
  readonly anchorMessageId: string;
  readonly anchorContent: string;
}

/**
 * Virtual-window-safe restore targeting for persisted agent traces (Issue
 * #551 follow-up, restored-console mis-anchor fix).
 *
 * DeepSeek renders chat history through a virtual list, so `messages` is only
 * the currently rendered window and array positions are window-relative: an
 * index captured at run time (`anchorMessageIndex`) or a global assistant
 * ordinal from history metadata (`assistantMessageIndex`) points at the WRONG
 * message once the window moves. Restored consoles anchored through such
 * indices mounted under unrelated newer messages - a restored run's console
 * appeared inside the newest reply.
 *
 * Anchoring therefore trusts only identity signals: the DOM message id and
 * the message's own visible text (plus the own text of persisted tool records
 * from the same anchor message). When the anchor message is not rendered the
 * function returns null and the trace stays pending; the mutation-driven
 * re-render mounts it as soon as its message scrolls into view. No mount is
 * always better than a wrong mount.
 */
export function findInlineAgentRestoreTarget(
  anchor: InlineAgentRestoreAnchor,
  toolContentHints: readonly string[],
  messages: Element[],
  usedMessages: Set<Element>,
): Element | null {
  if (anchor.anchorMessageId) {
    const byId = messages.find((message) => {
      if (usedMessages.has(message)) return false;
      return elementHasMessageId(message, anchor.anchorMessageId);
    });
    if (byId) return byId;
  }

  const byContent = findAssistantMessageByContentSnippet(messages, anchor.anchorContent, usedMessages);
  if (byContent) return byContent;

  for (const hint of toolContentHints) {
    const byHint = findAssistantMessageByContentSnippet(messages, hint, usedMessages);
    if (byHint) return byHint;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Trace-owned step collapse (fix round 4, D3)
// ---------------------------------------------------------------------------

export interface TraceOwnedStepRecord {
  readonly index: number;
  readonly responseMessageId: number | null;
  readonly text: string;
}

/**
 * Matches a restored run's loop-step messages in the rendered native history
 * so the restore flow can COLLAPSE them: the loop commits every step to the
 * native chain, and after a reload each step renders as a standalone native
 * bubble - double-rendering content the restored console already owns (worst
 * live case: the previous turn's full answer "reappearing" as a surprise).
 *
 * Identity rules, in order of trust (mirrors findInlineAgentRestoreTarget):
 *  1. the step's committed responseMessageId when the DOM exposes it;
 *  2. the step's own persisted text, markdown-normalized, same as anchoring,
 *     ANCHORED AT THE MESSAGE START (review fix): a message that merely
 *     contains the snippet mid-text (a later summary quoting the step's
 *     opening line) is not the step's bubble and must never be collapsed.
 * Steps are processed in order and each match constrains the next search to
 * later document positions (steps commit in order), which also stops a later
 * step from consuming an earlier message. Already-used messages (consoles,
 * earlier collapses) are skipped; weak text (<12 normalized chars, the same
 * floor as content anchoring) never matches - no match is better than a
 * wrong collapse.
 */
export function matchTraceOwnedStepMessages(
  messages: Element[],
  steps: readonly TraceOwnedStepRecord[],
  usedMessages: Set<Element>,
): Map<number, Element> {
  const matched = new Map<number, Element>();
  let searchFrom = 0;

  for (const step of steps) {
    let matchedIndex = -1;

    if (step.responseMessageId !== null && step.responseMessageId > 0) {
      const id = String(step.responseMessageId);
      for (let i = searchFrom; i < messages.length; i += 1) {
        if (usedMessages.has(messages[i])) continue;
        if (elementHasMessageId(messages[i], id)) {
          matchedIndex = i;
          break;
        }
      }
    }

    if (matchedIndex === -1) {
      const snippet = normalizeAnchorText(step.text).slice(0, 100);
      if (snippet.length >= 12) {
        for (let i = searchFrom; i < messages.length; i += 1) {
          const message = messages[i];
          if (usedMessages.has(message)) continue;
          // Start-anchored: the step's text opens the message. A mid-message
          // mention (a summary quoting the step) is a different bubble.
          if (normalizeAnchorText(getAssistantMessageOwnText(message)).startsWith(snippet)) {
            matchedIndex = i;
            break;
          }
        }
      }
    }

    if (matchedIndex !== -1) {
      matched.set(step.index, messages[matchedIndex]);
      searchFrom = matchedIndex + 1;
    }
  }

  return matched;
}
