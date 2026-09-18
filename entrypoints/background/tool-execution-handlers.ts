import type { SupportedLocale } from '../../core/i18n';
import { withInlineAgentSubagentSpawnDescriptor } from '../../core/inline-agent/subagent-tool';
import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type { PlatformEnvironment } from '../../core/platform/capabilities';
import type { SandboxRunRequest } from '../../core/sandbox/types';
import type {
  CreateToolAuthorizationInput,
} from '../../core/tool/authorization';
import { ToolAuthorizationError } from '../../core/tool/authorization';
import type {
  RuntimeToolAuthorizationContext,
  ToolAuthorizationGrantSummary,
  ToolAuthorizationSubject,
  ToolCall,
  ToolCallHistoryRecord,
  ToolDescriptor,
  ToolExecutionTrigger,
  ToolResult,
  TrustedToolExecutionContext,
} from '../../core/tool/types';
import type { RuntimeMessageContext } from '../../core/messaging/runtime-boundary';
import { defineToolPayloadRuntimeCommandHandler } from './runtime-handler';

export interface ExternalPayloadAuthorizationBinding {
  grantId: string;
  subject: ToolAuthorizationSubject;
  callId: string;
  invocationName: string;
}

export interface ExternalPayloadAuthorizationCachePort {
  has(binding: ExternalPayloadAuthorizationBinding): boolean;
  remember(binding: ExternalPayloadAuthorizationBinding, expiresAt: number): void;
  deleteGrant(grantId: string): void;
  deleteCall(grantId: string, callId: string): void;
}

export interface ToolExecutionRuntimeHandlerDependencies {
  getLocale(): SupportedLocale;
  getToolDescriptors(locale: SupportedLocale): Promise<ToolDescriptor[]>;
  getPromptToolDescriptors(locale: SupportedLocale, intent: string): Promise<ToolDescriptor[]>;
  getAuthorizationDescriptors(locale: SupportedLocale): Promise<ToolDescriptor[]>;
  refreshToolDescriptors(locale: SupportedLocale): Promise<ToolDescriptor[]>;
  createToolAuthorization(input: CreateToolAuthorizationInput): Promise<ToolAuthorizationGrantSummary>;
  /** Background validation: whether a given directory belongs to an imported local skill (Review #2). */
  validateLocalSkillDirectory(dir: string): Promise<boolean>;
  closeToolAuthorization(
    authorizationId: string,
    subject: ToolAuthorizationSubject,
  ): Promise<void>;
  authorizeExternalToolPayloadChunk(input: ExternalPayloadAuthorizationBinding & {
    currentDescriptors: readonly ToolDescriptor[];
  }): Promise<{ namespace: string; expiresAt: number }>;
  createToolAuthorizationResult(error: ToolAuthorizationError): ToolResult;
  createInvalidToolCallResult(value: unknown, locale: SupportedLocale): ToolResult;
  externalPayloadAuthorizationCache: ExternalPayloadAuthorizationCachePort;
  appendExternalizedToolPayloadChunk(
    callId: string,
    invocationName: string,
    chunk: string,
    namespace: string,
  ): void;
  clearExternalizedToolPayloadNamespace(namespace: string): void;
  executeToolCall(
    call: ToolCall,
    authorization: RuntimeToolAuthorizationContext,
    locale: SupportedLocale,
  ): Promise<ToolResult>;
  runSandbox(request: SandboxRunRequest): Promise<ToolResult>;
  getToolCallHistory(limit?: number): Promise<ToolCallHistoryRecord[]>;
  clearToolCallHistory(): Promise<void>;
  getPlatformEnvironment(): PlatformEnvironment;
  createRequestId(): string;
  now(): number;
  sandboxInvalidRequestSummary(): string;
  broadcastToolDescriptorsUpdate(excludeTabId?: number): Promise<void>;
  broadcastMcpServersUpdate(excludeTabId?: number): Promise<void>;
  broadcastToolCallHistoryUpdate(excludeTabId?: number): Promise<void>;
}

export function createToolExecutionRuntimeHandlers(
  dependencies: ToolExecutionRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_TOOL_DESCRIPTORS', () => (
      dependencies.getToolDescriptors(dependencies.getLocale())
    )),
    definePayloadlessRuntimeCommandHandler('REFRESH_TOOL_DESCRIPTORS', async (context) => {
      const tools = await dependencies.refreshToolDescriptors(dependencies.getLocale());
      await dependencies.broadcastToolDescriptorsUpdate(context.tabId);
      await dependencies.broadcastMcpServersUpdate(context.tabId);
      return tools;
    }),
    defineToolPayloadRuntimeCommandHandler('CREATE_TOOL_AUTHORIZATION', async (decoded, context) => {
      if (context.surface !== 'deepseek_content') {
        return { ok: false as const, error: 'tool_authorization_requires_content_runtime' };
      }
      if (decoded.ok === false) {
        return { ok: false as const, error: decoded.error };
      }

      const payload = decoded.payload;
      const locale = dependencies.getLocale();
      const currentDescriptors = payload.descriptorIds
        ? await dependencies.getToolDescriptors(locale)
        : await dependencies.getPromptToolDescriptors(locale, payload.toolIntent ?? '');
      // P1 subagent (M5) + first-turn access (pc directive, 2026-09-18): the
      // spawn descriptor merges into agent_run grants AND manual_chat grants.
      // Manual chat is where the FIRST turn lives: merging here advertises
      // `subagent_spawn` in the turn's `### Tool` section (the render surface
      // projects `authorization.descriptors`) and makes the native-turn parser
      // recognize its XML tag. The shared prompt catalogs (manual chat /
      // sidepanel / automation prompt sources) stay byte-identical — only the
      // grant-time merge widens. Spawn EXECUTION stays loop-owned: content
      // defers a first-turn spawn call into the inline-agent loop, which
      // executes it through the authorized agent_run path (step 0). The
      // descriptor text/identity come from the single factory in
      // core/inline-agent/subagent-tool.ts.
      const grantableDescriptors =
        payload.trigger === 'agent_run' || payload.trigger === 'manual_chat'
          ? withInlineAgentSubagentSpawnDescriptor(currentDescriptors)
          : currentDescriptors;
      const requestedIds = payload.descriptorIds;
      const requestedDescriptorIds = requestedIds
        ? new Set(requestedIds)
        : null;
      const descriptors = requestedDescriptorIds
        ? grantableDescriptors.filter((descriptor) => requestedDescriptorIds.has(descriptor.id))
        : grantableDescriptors;
      // Descriptor reconciliation: MCP/web/browser registry churn between the
      // turn's grant and a later id-scoped request (loop start, regenerate
      // scope) must never kill the run with a hard unknown-descriptor failure.
      // Grant the intersection; when NOTHING requested is grantable anymore
      // (and the caller actually requested tools), grant the full grantable
      // set so the run keeps working. An explicit empty selection stays the
      // released empty-grant path — the caller asked for no tools.
      const effectiveDescriptors =
        requestedDescriptorIds && requestedDescriptorIds.size > 0 && descriptors.length === 0
          ? grantableDescriptors
          : descriptors;
      const grantedDescriptorIds = new Set(effectiveDescriptors.map((d) => d.id));
      const unavailableToolNames = requestedIds
        ? [
          ...new Set(
            requestedIds
              .map((id, index) =>
                grantedDescriptorIds.has(id)
                  ? null
                  : payload.descriptorNames?.[index] ?? id,
              )
              .filter((name): name is string => name !== null),
          ),
        ]
        : [];

      // Review #2: the page/model-supplied localSkillDir is untrusted; write it
      // to the grant only when background confirms it belongs to an imported
      // local-skill directory, otherwise do not force cwd.
      const requestedLocalSkillDir = payload.localSkillDir;
      const validatedLocalSkillDir =
        requestedLocalSkillDir && await dependencies.validateLocalSkillDirectory(requestedLocalSkillDir)
          ? requestedLocalSkillDir
          : undefined;
      const summary = await dependencies.createToolAuthorization({
        requestId: payload.requestId,
        trigger: payload.trigger,
        chatSessionId: payload.chatSessionId,
        runId: payload.runId,
        subject: createToolAuthorizationSubject(context),
        descriptors: effectiveDescriptors,
        localSkillDir: validatedLocalSkillDir,
      });
      // Additive, in-memory-only result extension: the DROPPED tools' names
      // ride to content so the inline-agent loop can tell the model once (in
      // continuation prompt bytes). When nothing is dropped the response stays
      // byte-identical to the released grant summary.
      return unavailableToolNames.length > 0
        ? { ...summary, unavailableToolNames }
        : summary;
    }),
    defineToolPayloadRuntimeCommandHandler('CLOSE_TOOL_AUTHORIZATION', async (decoded, context) => {
      if (decoded.ok === false) {
        return { ok: false as const, error: decoded.error };
      }
      const { authorizationId } = decoded.payload;
      await dependencies.closeToolAuthorization(
        authorizationId,
        createToolAuthorizationSubject(context),
      );
      dependencies.externalPayloadAuthorizationCache.deleteGrant(authorizationId);
      dependencies.clearExternalizedToolPayloadNamespace(authorizationId);
      return { ok: true as const };
    }),
    defineToolPayloadRuntimeCommandHandler(
      'APPEND_EXTERNAL_TOOL_PAYLOAD_CHUNK',
      async (decoded, context) => {
        if (decoded.ok === false) {
          return { ok: false as const, error: decoded.error };
        }
        const payload = decoded.payload;
        try {
          const binding: ExternalPayloadAuthorizationBinding = {
            grantId: payload.authorizationId,
            subject: createToolAuthorizationSubject(context),
            callId: payload.callId,
            invocationName: payload.invocationName,
          };
          if (!dependencies.externalPayloadAuthorizationCache.has(binding)) {
            const authorization = await dependencies.authorizeExternalToolPayloadChunk({
              ...binding,
              currentDescriptors: await dependencies.getAuthorizationDescriptors(
                dependencies.getLocale(),
              ),
            });
            dependencies.externalPayloadAuthorizationCache.remember(
              binding,
              authorization.expiresAt,
            );
          }
          dependencies.appendExternalizedToolPayloadChunk(
            payload.callId,
            payload.invocationName,
            payload.chunk,
            payload.authorizationId,
          );
        } catch (error) {
          if (!(error instanceof ToolAuthorizationError)) throw error;
          return dependencies.createToolAuthorizationResult(error);
        }
        return { ok: true as const };
      },
    ),
    defineToolPayloadRuntimeCommandHandler('EXECUTE_TOOL_CALL', async (decoded, context) => {
      const locale = dependencies.getLocale();
      if (decoded.ok === false) {
        return dependencies.createInvalidToolCallResult(decoded.call, locale);
      }
      const { authorizationId, call } = decoded;
      if (authorizationId && call.id) {
        dependencies.externalPayloadAuthorizationCache.deleteCall(authorizationId, call.id);
      }
      const authorization: RuntimeToolAuthorizationContext = context.surface === 'deepseek_content'
        ? {
          kind: 'grant',
          grantId: authorizationId ?? '',
          subject: createToolAuthorizationSubject(context),
        }
        : createTrustedToolExecutionContext(
          call,
          'manual_chat',
          dependencies.createRequestId,
        );
      const result = await dependencies.executeToolCall(
        call,
        authorization,
        locale,
      );
      await dependencies.broadcastToolCallHistoryUpdate(context.tabId);
      return result;
    }),
    defineToolPayloadRuntimeCommandHandler('RUN_ARTIFACT_CODE', (decoded) => {
      if (decoded.ok === true) return dependencies.runSandbox(decoded.payload);
      const now = dependencies.now();
      return {
        ok: false,
        summary: dependencies.sandboxInvalidRequestSummary(),
        detail: decoded.detail,
        error: {
          code: 'sandbox_invalid_request',
          message: decoded.detail,
          retryable: false,
        },
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        truncated: false,
      };
    }),
    defineToolPayloadRuntimeCommandHandler('GET_TOOL_CALL_HISTORY', (payload) => (
      dependencies.getToolCallHistory(payload?.limit)
    )),
    definePayloadlessRuntimeCommandHandler('CLEAR_TOOL_CALL_HISTORY', async (context) => {
      await dependencies.clearToolCallHistory();
      await dependencies.broadcastToolCallHistoryUpdate(context.tabId);
      return { ok: true as const };
    }),
    definePayloadlessRuntimeCommandHandler('GET_PLATFORM_CAPABILITIES', () => (
      dependencies.getPlatformEnvironment()
    )),
  ]);
}

export function createToolAuthorizationSubject(
  context: RuntimeMessageContext,
): ToolAuthorizationSubject {
  // Firefox may omit MessageSender.documentId. Keep the receiver-owned
  // tab/frame identity stable across DeepSeek SPA route changes; a full
  // navigation destroys the content runtime and revokes its in-memory grant.
  const documentSessionId = context.documentId
    ? context.documentSessionId
    : `${context.surface}:${context.tabId ?? 'extension'}:${context.frameId ?? 'extension'}`;
  return {
    surface: context.surface,
    documentSessionId,
    tabId: context.tabId,
    frameId: context.frameId,
    chatSessionId: context.chatSessionId ?? null,
  };
}

export function createTrustedToolExecutionContext(
  call: ToolCall,
  trigger: ToolExecutionTrigger,
  createRequestId: () => string = () => crypto.randomUUID(),
  capabilityScopeId?: string,
): TrustedToolExecutionContext {
  return {
    kind: 'trusted',
    trigger,
    requestId: call.source?.requestId
      ?? call.source?.automationRunId
      ?? call.source?.runId
      ?? createRequestId(),
    capabilityScopeId,
    chatSessionId: call.source?.chatSessionId ?? null,
    taskId: call.source?.taskId,
    runId: call.source?.runId,
    automationId: call.source?.automationId,
    automationRunId: call.source?.automationRunId,
  };
}
