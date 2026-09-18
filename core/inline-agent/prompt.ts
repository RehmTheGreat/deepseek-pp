import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n';
import { renderToolSchemas } from '../prompt/augmentation';
import type { ToolDescriptor, ToolError, ToolExecutionRecord } from '../types';

const PENDING_ACTION_RE = /(?:我(?:将|会|想|要|先|让|再|直接|现在|继续|尝试|开始|需要|还需要|仍需|打算|计划|马上|随后|稍后|先去|先来|接下来).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:接下来|下一步|然后|让我|先让我).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:(?:现在|这就|马上|随后|稍后|立即|立刻|先|直接))?(?:为|帮)(?:你|您)(?:创建|生成|制作|输出|编写|绘制|渲染)(?!了|好|完|成|过|的)|(?:i(?:'ll| will|'m| am|'d| would| want to| should| have to| (?:still\s+)?need to|'m going to| am going to|'m about to| am about to|'ve got to| have got to)|let me|let's|next,? (?:i|we)|we(?:'ll| will| need to| can)|(?:my|the) next step is to).{0,64}(?:call|create|edit|inspect|validate|generate|save|try|search|fetch|open|run|browse|read|check|look|use|verify|test|download|write|update|review|analyze|extract|query|send|post|investigate|monitor|compare|install|start|stop|convert|parse|list|collect|request|retry|scroll|click|type|navigate))/gi;
const NUDGE_DECISION_TAIL_MAX_CHARS = 600;
const PENDING_ACTION_AFTER_MAX_CHARS = 80;
const TASK_COMPLETE_RE = /<task_complete>\s*([\s\S]*?)\s*<\/task_complete>/;
export const TASK_COMPLETE_BLOCK_RE = /<task_complete>\s*([\s\S]*?)\s*<\/task_complete>/g;

// Keep the persisted continuation turn non-empty so DeepSeek retains its
// parent/child message chain, while making the internal marker invisible even
// if DeepSeek temporarily exposes the turn in an editor.
export const INLINE_AGENT_CONTINUATION_PLACEHOLDER = '\u2063\u2064\u2063';
/**
 * The most recent tool executions rendered with full detail/output in
 * continuation and nudge prompts. Older executions are compressed to a
 * bounded summary so the model-facing context stays near-constant across
 * steps instead of growing with every executed tool.
 */
export const INLINE_AGENT_FULL_TOOL_RESULT_WINDOW = 4;

export function extractTaskCompleteSignal(text: string): { summary: string; artifacts: string[] } | null {
  const match = TASK_COMPLETE_RE.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : match[1].trim(),
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.filter((a: unknown) => typeof a === 'string') : [],
    };
  } catch {
    return { summary: match[1].trim(), artifacts: [] };
  }
}

export function replaceTaskCompleteBlocks(text: string): string {
  return text.replace(TASK_COMPLETE_BLOCK_RE, (_match, body: string) => {
    return getTaskCompleteSummary(body);
  });
}

export function normalizeInlineAgentFinalAnswerText(text: string): string {
  return stripDanglingLeadingPunctuation(replaceTaskCompleteBlocks(text).trim());
}

function hasInlineAgentContinuationTags(content: string): boolean {
  if (!content.includes('<original_task>') || !content.includes('</original_task>')) return false;
  return content.includes('<tool_results>') || content.includes('<tool_results_so_far>');
}

/**
 * Resume-prompt markers (fix/v1.14.1-tool-loop): the auto-resume prompt
 * carries the `<original_task>` pair but deliberately no `<tool_results>`
 * tag, so the tags-pair rule alone would leave the resume turn visible in
 * the DS chat. Internal turns must stay invisible (live-DOM hiding, history
 * cleanup, fetch suppression), so detection also accepts the tag pair plus
 * the pinned resume instruction line — EN and zh-CN, byte-identical prefixes
 * of the `prompt.inlineAgent.resumeInterrupted` resources locked by the
 * prompt goldens. A real user message would need the tag pair AND that exact
 * sentence: the same false-positive profile as the tags-pair rule.
 */
const INLINE_AGENT_RESUME_INTERRUPTED_MARKERS = [
  'Your previous response was interrupted mid-stream.',
  '你之前的回复在流式输出中途被打断。',
] as const;

function hasInlineAgentResumePromptMarker(content: string): boolean {
  return INLINE_AGENT_RESUME_INTERRUPTED_MARKERS.some((marker) => content.includes(marker));
}

/**
 * Subagent child framing markers (spawn-quality diagnosis fix 2): the child's
 * FIRST request carries the dedicated task intro instead of the continuation
 * template. Byte-identical prefixes of the `prompt.inlineAgent.subagentTaskIntro`
 * resources locked by the prompt goldens. Detector duty is identical to the
 * resume markers above: the `<original_task>` pair plus this exact sentence
 * classifies the turn as an internal inline-agent request (page-event
 * suppression, history hiding) so the child's task never renders as a visible
 * user bubble in the DS chat.
 */
const INLINE_AGENT_SUBAGENT_TASK_MARKERS = [
  'You are a subagent spawned to complete a specific task.',
  '你是一个为完成特定任务而启动的子代理。',
] as const;

function hasInlineAgentSubagentTaskMarker(content: string): boolean {
  return INLINE_AGENT_SUBAGENT_TASK_MARKERS.some((marker) => content.includes(marker));
}

/** The auto-resume shape: `<original_task>` pair + resume instruction line, no tool results. */
function hasInlineAgentResumePromptTags(content: string): boolean {
  if (!content.includes('<original_task>') || !content.includes('</original_task>')) return false;
  return hasInlineAgentResumePromptMarker(content);
}

/**
 * The subagent child first-request shape: `<original_task>` pair + the
 * dedicated subagent task intro line, no tool results (the child has executed
 * nothing yet — the empty `<tool_results> []` premise is exactly what the
 * child framing fix removed).
 */
function hasInlineAgentSubagentTaskTags(content: string): boolean {
  if (!content.includes('<original_task>') || !content.includes('</original_task>')) return false;
  return hasInlineAgentSubagentTaskMarker(content);
}

/**
 * True when either prompt field of an internal inline-agent continuation
 * request is present. Shared by the fetch hook (to suppress page events for
 * internal requests) and the content script (to skip starting a fresh agent
 * loop off an already-internal response).
 */
export function isInlineAgentContinuationRequest(originalPrompt: string, agentTaskPrompt: string): boolean {
  return isInlineAgentContinuationPrompt(originalPrompt) ||
    isInlineAgentContinuationPrompt(agentTaskPrompt);
}

export function isInlineAgentContinuationPrompt(content: string): boolean {
  // The auto-resume and subagent-child first-request shapes are recognized by
  // their own pair+marker rules; the keyword list below applies to the
  // tool-results continuation/nudge shape.
  if (hasInlineAgentResumePromptTags(content)) return true;
  if (hasInlineAgentSubagentTaskTags(content)) return true;
  if (!hasInlineAgentContinuationTags(content)) return false;

  return content.includes('工具续跑任务') ||
    content.includes('工具结果') ||
    content.includes('Continue like a real agent') ||
    content.includes('tool results') ||
    content.includes('do not call any tools') ||
    content.includes('不要调用任何工具');
}

/**
 * Looser structural detector for inline-agent continuation text as rendered in
 * the live DOM. DeepSeek may interleave its own chrome (timestamps, action
 * rows, reasoning fragments) with the continuation prompt, so the strict
 * {@link isInlineAgentContinuationPrompt} keyword check can miss it and leave
 * an empty user bubble. The paired `<original_task>` + `<tool_results[_so_far]>`
 * tags are a strong enough structural signal on their own — a real user
 * message would not contain both — so we drop the keyword requirement here.
 *
 * The strict version is still used for history-list API cleanup, where the
 * raw prompt text is intact and false positives are costlier.
 */
export function isInlineAgentContinuationStructure(content: string): boolean {
  return hasInlineAgentContinuationTags(content)
    || hasInlineAgentResumePromptTags(content)
    || hasInlineAgentSubagentTaskTags(content);
}

function getTaskCompleteSummary(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.summary === 'string' ? parsed.summary : body.trim();
  } catch {
    return body.trim();
  }
}

export function stripDanglingLeadingPunctuation(text: string): string {
  return text.replace(/^[\s\u3000]*(?:[，,、。．.;；:：]\s*)+/, '').trimStart();
}

export function shouldNudge(
  originalTask: string,
  executions: ToolExecutionRecord[],
  visibleText: string,
): boolean {
  if (extractTaskCompleteSignal(visibleText)) return false;
  if (!visibleText) return true;
  return hasPendingActionAtTail(getNudgeDecisionText(visibleText));
}

function getNudgeDecisionText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > NUDGE_DECISION_TAIL_MAX_CHARS
    ? trimmed.slice(-NUDGE_DECISION_TAIL_MAX_CHARS)
    : trimmed;
}

function hasPendingActionAtTail(text: string): boolean {
  const matches = [...text.matchAll(PENDING_ACTION_RE)];
  const lastMatch = matches[matches.length - 1];
  if (!lastMatch || lastMatch.index === undefined) return false;

  const afterPendingAction = text.slice(lastMatch.index + lastMatch[0].length).trim();
  if (afterPendingAction.length > PENDING_ACTION_AFTER_MAX_CHARS) return false;
  // A fenced code block right after the pending-action phrase IS the
  // deliverable (the DeepSeek native renderer takes it over): the tail is a
  // renderable body, not an empty promise — nothing is pending, no nudge.
  if (afterPendingAction.includes('```')) return false;
  return true;
}

/**
 * Builds the loop's continuation prompt. `unavailableToolNames` carries the
 * tools the background reconciliation dropped from this run's grant (registry
 * churn between the turn grant and the loop grant): when present, exactly ONE
 * localized line is PREPENDED naming them, so the model does not call them
 * again and uses the tools that are actually granted below. Absent/empty →
 * the released continuation bytes, unchanged.
 *
 * `toolDescriptors` carries the loop's model-facing descriptor set (the FULL
 * runtime catalog plus subagent_spawn). When present, the SAME '### Tool'
 * schema section the first turn's system prompt uses is APPENDED after the
 * tool results, so the model sees its callable tools — including
 * subagent_spawn — on every loop turn. Absent/empty → no section, released
 * bytes.
 */
export function buildContinuationPrompt(
  originalTask: string,
  executions: ToolExecutionRecord[],
  locale: SupportedLocale = DEFAULT_LOCALE,
  unavailableToolNames?: readonly string[],
  toolDescriptors?: readonly ToolDescriptor[],
): string {
  const hasFailures = executions.some((e) => !e.result.ok);
  const results = renderWindowedToolResults(executions);
  const unavailableNotice = unavailableToolNames?.length
    ? [translate(
      locale,
      'prompt.inlineAgent.unavailableTools',
      { names: unavailableToolNames.join(', ') },
    )]
    : [];

  return [
    ...unavailableNotice,
    translate(locale, 'prompt.inlineAgent.continuationIntro'),
    translate(locale, 'prompt.inlineAgent.continuationEnough'),
    translate(locale, 'prompt.inlineAgent.continuationNoPseudo'),
    translate(locale, 'prompt.inlineAgent.nativeChartSyntax'),
    '',
    '<original_task>',
    clampText(originalTask, 8000),
    '</original_task>',
    ...(hasFailures ? [
      translate(locale, 'prompt.inlineAgent.failureRecovery'),
    ] : []),
    '',
    '<tool_results>',
    JSON.stringify(results, null, 2),
    '</tool_results>',
    ...renderLoopToolSection(toolDescriptors, locale),
  ].join('\n');
}

/**
 * Builds a subagent child's FIRST request prompt (child framing fix,
 * spawn-quality diagnosis §4.2). The child is NOT continuing a tool turn: it
 * has executed nothing yet, so the released continuation template's "these
 * are the tool results just executed" premise and its literal
 * `<tool_results> []` are a lie the child model quoted back verbatim. This
 * dedicated intro instead establishes subagent identity, isolates the
 * ambient conversation ("messages above are context only"), and states the
 * deliverable contract: execute the task with the child's tools, then emit
 * the final deliverable as the last message (the child's final text IS the
 * parent's tool result, unchanged).
 *
 * The `<original_task>` pair is kept (with the pair+marker detector legs in
 * this module) so the child's first request stays classified as an internal
 * inline-agent turn everywhere (fetch-hook page-event suppression, history
 * cleanup, live-DOM structural hiding) — without it the child's task would
 * render as a visible user bubble in the DS chat. The tool-schema section is
 * appended from the child's DERIVED descriptor set (spawn-free, depth 1),
 * exactly like every other loop request.
 */
export function buildSubagentTaskPrompt(
  task: string,
  locale: SupportedLocale = DEFAULT_LOCALE,
  toolDescriptors?: readonly ToolDescriptor[],
): string {
  return [
    translate(locale, 'prompt.inlineAgent.subagentTaskIntro'),
    translate(locale, 'prompt.inlineAgent.subagentTaskDeliverable'),
    translate(locale, 'prompt.inlineAgent.subagentTaskContext'),
    '',
    '<original_task>',
    clampText(task, 8000),
    '</original_task>',
    ...renderLoopToolSection(toolDescriptors, locale),
  ].join('\n');
}

/**
 * Builds the resume prompt for an interrupted turn (fix/v1.14.1-tool-loop):
 * continuation-style framing — instruction lines plus the `<original_task>`
 * block, like `buildContinuationPrompt` — but with NO `<tool_results>` (the
 * interrupted stream died before its tools could matter; prior results are
 * already in the conversation chain) and deliberately NO
 * `<previous_assistant_text>` (its nudge semantics do not apply to a stream
 * that never completed). The model continues the same task from the last
 * committed chain point without repeating completed work.
 */
export function buildResumePrompt(
  originalTask: string,
  resumeCount: number,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  return [
    translate(locale, 'prompt.inlineAgent.resumeInterrupted'),
    translate(locale, 'prompt.inlineAgent.resumeCount', { count: resumeCount }),
    '',
    '<original_task>',
    clampText(originalTask, 8000),
    '</original_task>',
  ].join('\n');
}

export function buildNudgePrompt(
  originalTask: string,
  previousText: string,
  executions: ToolExecutionRecord[],
  nudgeCount: number,
  locale: SupportedLocale = DEFAULT_LOCALE,
  toolDescriptors?: readonly ToolDescriptor[],
): string {
  const results = renderWindowedToolResults(executions);

  return [
    translate(locale, 'prompt.inlineAgent.nudgeNoTools'),
    translate(locale, 'prompt.inlineAgent.nudgeChoice'),
    translate(locale, 'prompt.inlineAgent.nudgeNextTool'),
    translate(locale, 'prompt.inlineAgent.nudgeComplete'),
    translate(locale, 'prompt.inlineAgent.nativeChartSyntax'),
    translate(locale, 'prompt.inlineAgent.nudgeCount', { count: nudgeCount }),
    '',
    '<original_task>',
    clampText(originalTask, 8000),
    '</original_task>',
    '',
    '<previous_assistant_text>',
    clampText(previousText, 4000),
    '</previous_assistant_text>',
    '',
    '<tool_results_so_far>',
    JSON.stringify(results, null, 2),
    '</tool_results_so_far>',
    ...renderLoopToolSection(toolDescriptors, locale),
  ].join('\n');
}

/**
 * The loop's tool-schema advertisement (uniform-tools task 4): the SAME
 * `renderToolSchemas` rendering the first turn's system section uses
 * (`### Tool <name>` blocks with the valid call format), appended after the
 * tool results so the model sees its callable tools — including
 * `subagent_spawn` — on every loop turn. No descriptors → empty (released
 * bytes). Resume prompts deliberately never call this: the resume turn
 * carries chain context only.
 */
function renderLoopToolSection(
  toolDescriptors: readonly ToolDescriptor[] | undefined,
  locale: SupportedLocale,
): string[] {
  if (!toolDescriptors?.length) return [];
  return ['', renderToolSchemas(toolDescriptors, locale)];
}

function renderWindowedToolResults(executions: ToolExecutionRecord[]) {
  if (executions.length <= INLINE_AGENT_FULL_TOOL_RESULT_WINDOW) {
    return executions.map(renderToolResult);
  }
  const older = executions.slice(0, -INLINE_AGENT_FULL_TOOL_RESULT_WINDOW);
  const recent = executions.slice(-INLINE_AGENT_FULL_TOOL_RESULT_WINDOW);
  return [
    ...older.map(renderCompressedToolResult),
    ...recent.map(renderToolResult),
  ];
}

function renderToolResult(e: ToolExecutionRecord) {
  return {
    tool: e.name,
    provider: e.provider?.displayName,
    ok: e.result.ok,
    summary: e.result.summary,
    detail: clampText(e.result.detail, 4000),
    error: boundToolError(e.result.error),
    output: clampText(
      e.result.output === undefined ? undefined : JSON.stringify(e.result.output),
      8000,
    ),
    truncated: e.result.truncated === true,
  };
}

function renderCompressedToolResult(e: ToolExecutionRecord) {
  return {
    tool: e.name,
    provider: e.provider?.displayName,
    ok: e.result.ok,
    summary: clampText(e.result.summary, 400),
    error: boundToolError(e.result.error),
    windowed: true,
    truncated: e.result.truncated === true,
  };
}

function boundToolError(error: ToolError | undefined): ToolError | undefined {
  if (!error) return undefined;
  return {
    code: error.code,
    message: clampText(error.message, 400) ?? '',
    retryable: error.retryable,
  };
}

function clampText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}
