import { isExtensionCapability, type ExtensionCapability } from '../domain/extension';
import type { PluginPermissionBroker } from '../ports/plugin-permission-broker';

export const EXTENSION_SANDBOX_PROTOCOL = 'pure-tavern-extension/1' as const;

interface SandboxEnvelopeBase {
  protocol: typeof EXTENSION_SANDBOX_PROTOCOL;
  extensionId: string;
  sessionId: string;
  requestId: string;
}

export interface SandboxRequestEnvelope extends SandboxEnvelopeBase {
  kind: 'request';
  method: string;
  payload: unknown;
}

export interface SandboxSuccessEnvelope extends SandboxEnvelopeBase {
  kind: 'response';
  ok: true;
  result: unknown;
}

export interface SandboxErrorEnvelope extends SandboxEnvelopeBase {
  kind: 'response';
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type SandboxEnvelope =
  SandboxRequestEnvelope | SandboxSuccessEnvelope | SandboxErrorEnvelope;

export interface SandboxMessageEvent {
  data: unknown;
  source: unknown;
  origin: string;
}

export type SandboxCapabilityHandler = (payload: unknown) => Promise<unknown> | unknown;

export interface SandboxProtocolHostOptions {
  extensionId: string;
  sessionId: string;
  expectedSource: unknown;
  expectedOrigin: string;
  send: (envelope: SandboxEnvelope) => Promise<void> | void;
  permissions: PluginPermissionBroker;
  capabilityHandlers?: Partial<Record<ExtensionCapability, SandboxCapabilityHandler>>;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class SandboxTimeoutError extends Error {
  constructor(requestId: string, timeoutMs: number) {
    super(`Sandbox request ${requestId} timed out after ${timeoutMs}ms.`);
    this.name = 'SandboxTimeoutError';
  }
}

/** Host-side request/response channel shared by iframe and Worker transports. */
export class SandboxProtocolHost {
  readonly #extensionId: string;
  readonly #sessionId: string;
  readonly #expectedSource: unknown;
  readonly #expectedOrigin: string;
  readonly #send: (envelope: SandboxEnvelope) => Promise<void> | void;
  readonly #permissions: PluginPermissionBroker;
  readonly #handlers: Partial<Record<ExtensionCapability, SandboxCapabilityHandler>>;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  #sequence = 0;
  #disposed = false;

  constructor(options: SandboxProtocolHostOptions) {
    if (!options.extensionId || !options.sessionId) {
      throw new TypeError('Sandbox extensionId and sessionId must be non-empty.');
    }
    if (!Number.isFinite(options.timeoutMs ?? 5_000) || (options.timeoutMs ?? 5_000) <= 0) {
      throw new TypeError('Sandbox timeoutMs must be positive.');
    }
    this.#extensionId = options.extensionId;
    this.#sessionId = options.sessionId;
    this.#expectedSource = options.expectedSource;
    this.#expectedOrigin = options.expectedOrigin;
    this.#send = options.send;
    this.#permissions = options.permissions;
    this.#handlers = options.capabilityHandlers ?? {};
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    if (this.#disposed) throw new Error('Sandbox protocol host is disposed.');
    if (!method || method.length > 128)
      throw new TypeError('Sandbox method must be 1-128 characters.');
    const requestId = this.#nextRequestId();
    const envelope: SandboxRequestEnvelope = {
      protocol: EXTENSION_SANDBOX_PROTOCOL,
      extensionId: this.#extensionId,
      sessionId: this.#sessionId,
      requestId,
      kind: 'request',
      method,
      payload,
    };
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new SandboxTimeoutError(requestId, this.#timeoutMs));
      }, this.#timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timeout });
    });
    try {
      await this.#send(envelope);
    } catch (error) {
      const pending = this.#pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }

  async handleMessage(event: SandboxMessageEvent): Promise<boolean> {
    if (
      this.#disposed ||
      !Object.is(event.source, this.#expectedSource) ||
      event.origin !== this.#expectedOrigin ||
      !isSandboxEnvelope(event.data) ||
      event.data.extensionId !== this.#extensionId ||
      event.data.sessionId !== this.#sessionId
    ) {
      return false;
    }

    const envelope = event.data;
    if (envelope.kind === 'response') {
      const pending = this.#pending.get(envelope.requestId);
      if (!pending) return false;
      clearTimeout(pending.timeout);
      this.#pending.delete(envelope.requestId);
      if (envelope.ok) pending.resolve(envelope.result);
      else pending.reject(new Error(`${envelope.error.code}: ${envelope.error.message}`));
      return true;
    }

    await this.#handleRequest(envelope);
    return true;
  }

  dispose(reason = 'Sandbox protocol host disposed.'): void {
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  async #handleRequest(envelope: SandboxRequestEnvelope): Promise<void> {
    if (envelope.method !== 'capability.call' || !isRecord(envelope.payload)) {
      await this.#sendError(
        envelope.requestId,
        'unsupported-method',
        'Unsupported sandbox method.',
      );
      return;
    }
    const capability = envelope.payload.capability;
    if (!isExtensionCapability(capability)) {
      await this.#sendError(
        envelope.requestId,
        'unknown-capability',
        'Unknown extension capability.',
      );
      return;
    }
    if (!(await this.#permissions.check(this.#extensionId, capability))) {
      await this.#sendError(
        envelope.requestId,
        'permission-denied',
        `Capability is not granted: ${capability}`,
      );
      return;
    }
    const handler = this.#handlers[capability];
    if (!handler) {
      await this.#sendError(
        envelope.requestId,
        'capability-unavailable',
        `Capability has no host implementation: ${capability}`,
      );
      return;
    }
    try {
      const result = await handler(envelope.payload.input);
      await this.#send({
        protocol: EXTENSION_SANDBOX_PROTOCOL,
        extensionId: this.#extensionId,
        sessionId: this.#sessionId,
        requestId: envelope.requestId,
        kind: 'response',
        ok: true,
        result,
      });
    } catch (error) {
      await this.#sendError(
        envelope.requestId,
        'capability-error',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async #sendError(requestId: string, code: string, message: string): Promise<void> {
    await this.#send({
      protocol: EXTENSION_SANDBOX_PROTOCOL,
      extensionId: this.#extensionId,
      sessionId: this.#sessionId,
      requestId,
      kind: 'response',
      ok: false,
      error: { code, message },
    });
  }

  #nextRequestId(): string {
    this.#sequence += 1;
    return `${this.#sessionId}:${this.#sequence}`;
  }
}

export function isSandboxEnvelope(value: unknown): value is SandboxEnvelope {
  if (
    !isRecord(value) ||
    value.protocol !== EXTENSION_SANDBOX_PROTOCOL ||
    typeof value.extensionId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.requestId !== 'string' ||
    !value.extensionId ||
    !value.sessionId ||
    !value.requestId ||
    value.requestId.length > 256
  ) {
    return false;
  }
  if (value.kind === 'request') {
    return (
      typeof value.method === 'string' && value.method.length > 0 && value.method.length <= 128
    );
  }
  if (value.kind !== 'response' || typeof value.ok !== 'boolean') return false;
  if (value.ok) return Object.prototype.hasOwnProperty.call(value, 'result');
  return (
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
