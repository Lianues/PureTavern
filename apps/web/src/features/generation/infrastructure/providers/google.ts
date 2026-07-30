import { GEMINI_SAFETY, VERTEX_SAFETY } from '../../compatibility/upstream-constants';
import {
  calculateGoogleBudgetTokens,
  convertGooglePrompt,
} from '../../compatibility/upstream-prompt-converters';
import { getUpstreamGenerationConfig } from '../../compatibility/upstream-config';
import { isRecord, trimTrailingSlash } from '../../compatibility/upstream-utils';
import { exchangeVertexServiceAccount } from '../../compatibility/vertex-service-account';
import { GenerationProviderError, type ModelCatalogResult } from '../../domain/provider';
import { resolveProviderBaseUrl } from '../provider-url';
import { normalizeModels, parseJson, requestInit, requireOk } from './adapter-utils';
import type { ProviderAdapter, ProviderAdapterContext } from './provider-adapter';

export class GoogleAdapter implements ProviderAdapter {
  async listModels(context: ProviderAdapterContext): Promise<ModelCatalogResult> {
    const auth = await this.#authentication(context);
    const config = getUpstreamGenerationConfig();
    let url: URL;
    if (context.descriptor.source === 'makersuite') {
      const base = trimTrailingSlash(resolveProviderBaseUrl(context.descriptor, context.request));
      url = new URL(`${base}/${config.gemini.apiVersion}/models`);
      if (auth.apiKey) url.searchParams.set('key', auth.apiKey);
    } else {
      url = this.#vertexUrl(context, auth, 'models', false, true);
    }
    const response = await context.client.send(context.descriptor.source, url, {
      method: 'GET',
      headers: auth.headers,
      signal: context.signal ?? null,
    });
    const data = await parseJson(response);
    const models = normalizeModels(data.models)
      .filter(
        (model) =>
          context.descriptor.source !== 'makersuite' ||
          (Array.isArray(model.supportedGenerationMethods) &&
            model.supportedGenerationMethods.includes('generateContent')),
      )
      .map((model) => ({
        ...model,
        id: model.id.replace(/^models\//u, ''),
      }));
    return { data: models };
  }

  async generate(context: ProviderAdapterContext): Promise<Response> {
    const request = context.request;
    const model = requiredString(request.model, 'Model');
    const stream = Boolean(request.stream);
    const vertex = context.descriptor.source === 'vertexai';
    const config = getUpstreamGenerationConfig();
    const auth = await this.#authentication(context);
    const imageModels = new Set([
      'gemini-2.0-flash-exp',
      'gemini-2.0-flash-exp-image-generation',
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.5-flash-image-preview',
      'gemini-2.5-flash-image',
      'gemini-3-pro-image-preview',
      'gemini-3.1-flash-image-preview',
    ]);
    const noSearchModels = new Set([
      'gemini-2.0-flash-lite',
      'gemini-2.0-flash-lite-001',
      'gemini-2.0-flash-lite-preview-02-05',
      'gemini-robotics-er-1.5-preview',
    ]);
    const imageOutput = Boolean(request.request_images) && imageModels.has(model);
    const gemma3 = /gemma-3/u.test(model);
    const learnLm = model.includes('learnlm');
    const useSystemPrompt = !imageOutput && !gemma3 && Boolean(request.use_sysprompt);
    const converted = convertGooglePrompt(
      cloneMessages(request.messages),
      model,
      useSystemPrompt,
      promptNames(request),
    ) as {
      contents: Array<Record<string, unknown>>;
      system_instruction: { parts: unknown[] };
    };
    const generationConfig: Record<string, unknown> = {
      stopSequences: request.stop,
      candidateCount: 1,
      maxOutputTokens: request.max_tokens,
      temperature: request.temperature,
      topP: request.top_p,
      topK: request.top_k || undefined,
      responseMimeType:
        request.responseMimeType ??
        (isRecord(request.json_schema) ? 'application/json' : undefined),
      responseSchema:
        request.responseSchema ??
        (isRecord(request.json_schema) ? request.json_schema.value : undefined),
      seed: request.seed,
    };
    if (
      !Array.isArray(generationConfig.stopSequences) ||
      generationConfig.stopSequences.length === 0
    ) {
      delete generationConfig.stopSequences;
    }

    if (imageOutput) {
      generationConfig.responseModalities = ['text', 'image'];
      const aspectRatio = String(request.request_image_aspect_ratio ?? '');
      const imageSize = String(request.request_image_resolution ?? '');
      if (aspectRatio || imageSize) {
        generationConfig.imageConfig = {
          ...(imageSize && /^gemini-3/u.test(model) ? { imageSize } : {}),
          ...(aspectRatio ? { aspectRatio } : {}),
        };
      }
    }

    if (isThinkingModel(model)) {
      const thinkingConfig: Record<string, unknown> = {
        includeThoughts: Boolean(request.include_reasoning),
      };
      const budget = calculateGoogleBudgetTokens(
        Number(generationConfig.maxOutputTokens),
        String(request.reasoning_effort ?? ''),
        model,
      ) as number | string | null;
      if (typeof budget === 'number' && Number.isInteger(budget))
        thinkingConfig.thinkingBudget = budget;
      if (typeof budget === 'string' && budget) thinkingConfig.thinkingLevel = budget;
      if (vertex && budget === 0 && thinkingConfig.includeThoughts) {
        thinkingConfig.includeThoughts = false;
      }
      generationConfig.thinkingConfig = thinkingConfig;
    }

    const body: Record<string, unknown> = {
      contents: converted.contents,
      safetySettings: [...GEMINI_SAFETY, ...(vertex ? VERTEX_SAFETY : [])],
      generationConfig,
    };
    if (
      useSystemPrompt &&
      Array.isArray(converted.system_instruction.parts) &&
      converted.system_instruction.parts.length > 0
    ) {
      body.systemInstruction = converted.system_instruction;
    }

    const tools = buildTools(request, imageOutput, gemma3, learnLm, noSearchModels.has(model));
    if (tools.length > 0) {
      body.tools = tools;
      const functionCallingConfig = toolChoiceConfig(request.tool_choice);
      if (functionCallingConfig) body.toolConfig = { functionCallingConfig };
    }

    const operation = stream ? 'streamGenerateContent' : 'generateContent';
    let url: URL;
    if (vertex) {
      url = this.#vertexUrl(
        context,
        auth,
        `${encodeURIComponent(model)}:${operation}`,
        stream,
        false,
      );
    } else {
      const base = trimTrailingSlash(resolveProviderBaseUrl(context.descriptor, request));
      url = new URL(
        `${base}/${config.gemini.apiVersion}/models/${encodeURIComponent(model)}:${operation}`,
      );
      if (auth.apiKey) url.searchParams.set('key', auth.apiKey);
      if (stream) url.searchParams.set('alt', 'sse');
    }

    const response = await context.client.send(
      context.descriptor.source,
      url,
      requestInit({ 'Content-Type': 'application/json', ...auth.headers }, body, context.signal),
    );
    if (stream) return response;
    await requireOk(response);

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      throw new GenerationProviderError('invalid-response', 'Google returned invalid JSON.', 502);
    }
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    if (candidates.length === 0 || !isRecord(candidates[0])) {
      let message = `${vertex ? 'Google Vertex AI' : 'Google AI Studio'} API returned no candidate`;
      if (isRecord(data.promptFeedback) && typeof data.promptFeedback.blockReason === 'string') {
        message += `\nPrompt was blocked due to : ${data.promptFeedback.blockReason}`;
      }
      return responseWithJson(response, { error: { message } });
    }
    const candidate = candidates[0];
    const responseContent = candidate.content ?? candidate.output;
    const parts =
      isRecord(responseContent) && Array.isArray(responseContent.parts)
        ? responseContent.parts
        : [];
    const responseText =
      typeof responseContent === 'string'
        ? responseContent
        : parts
            .filter((part) => !isRecord(part) || !part.thought)
            .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n\n');
    const hasFunction = parts.some((part) => isRecord(part) && isRecord(part.functionCall));
    const hasImage = parts.some((part) => isRecord(part) && isRecord(part.inlineData));
    if (!responseText && !hasFunction && !hasImage) {
      return responseWithJson(response, {
        error: {
          message: `${vertex ? 'Google Vertex AI' : 'Google AI Studio'} Candidate text empty`,
        },
      });
    }
    return responseWithJson(response, {
      choices: [{ message: { content: responseText } }],
      responseContent,
    });
  }

  async #authentication(context: ProviderAdapterContext): Promise<GoogleAuthentication> {
    const request = context.request;
    if (context.descriptor.source === 'makersuite') {
      return { apiKey: context.credential, headers: {}, mode: 'api-key' };
    }
    if (hasReverseProxy(request)) {
      return {
        apiKey: null,
        headers: context.credential ? { Authorization: `Bearer ${context.credential}` } : {},
        mode: 'proxy',
      };
    }
    const authMode = request.vertexai_auth_mode ?? 'express';
    if (authMode === 'full') {
      if (!context.credential) {
        throw new GenerationProviderError(
          'missing-credential',
          'Vertex AI Service Account JSON is missing.',
          400,
        );
      }
      const token = await exchangeVertexServiceAccount(
        context.credential,
        context.client,
        context.signal,
      );
      return {
        apiKey: null,
        headers: { Authorization: `Bearer ${token.accessToken}` },
        mode: 'full',
        projectId: token.projectId,
      };
    }
    if (authMode === 'express') {
      return { apiKey: context.credential, headers: {}, mode: 'express' };
    }
    throw new GenerationProviderError(
      'invalid-request',
      `Unsupported Vertex AI authentication mode: ${String(authMode)}`,
      400,
    );
  }

  #vertexUrl(
    context: ProviderAdapterContext,
    auth: GoogleAuthentication,
    suffix: string,
    stream: boolean,
    modelList: boolean,
  ): URL {
    const request = context.request;
    const region =
      typeof request.vertexai_region === 'string' && request.vertexai_region
        ? request.vertexai_region
        : 'us-central1';
    let base: string;
    if (auth.mode === 'proxy') {
      base = `${trimTrailingSlash(resolveProviderBaseUrl(context.descriptor, request))}/v1/publishers/google`;
    } else if (auth.mode === 'full') {
      const host =
        region === 'global'
          ? 'https://aiplatform.googleapis.com'
          : `https://${region}-aiplatform.googleapis.com`;
      base = `${host}/v1/projects/${encodeURIComponent(auth.projectId ?? '')}/locations/${encodeURIComponent(region)}/publishers/google`;
    } else {
      const projectId =
        typeof request.vertexai_express_project_id === 'string'
          ? request.vertexai_express_project_id
          : '';
      if (projectId) {
        base = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/publishers/google`;
      } else {
        const host =
          region === 'global'
            ? 'https://aiplatform.googleapis.com'
            : `https://${region}-aiplatform.googleapis.com`;
        base = `${host}/v1/publishers/google`;
      }
    }
    const path = modelList ? `${base}/models` : `${base}/models/${suffix}`;
    const url = new URL(path);
    if (auth.mode === 'express' && auth.apiKey) url.searchParams.set('key', auth.apiKey);
    if (stream) url.searchParams.set('alt', 'sse');
    return url;
  }
}

interface GoogleAuthentication {
  apiKey: string | null;
  headers: Record<string, string>;
  mode: 'api-key' | 'express' | 'full' | 'proxy';
  projectId?: string;
}

function buildTools(
  request: Record<string, unknown>,
  imageOutput: boolean,
  gemma3: boolean,
  learnLm: boolean,
  noSearch: boolean,
): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  if (Array.isArray(request.tools) && request.tools.length > 0 && !imageOutput && !gemma3) {
    const declarations: Array<Record<string, unknown>> = [];
    const custom: Array<Record<string, unknown>> = [];
    for (const tool of structuredClone(request.tools)) {
      if (!isRecord(tool) || typeof tool.type !== 'string') continue;
      if (tool.type === 'function' && isRecord(tool.function)) {
        const declaration = tool.function;
        if (isRecord(declaration.parameters)) {
          delete declaration.parameters.$schema;
          if (
            isRecord(declaration.parameters.properties) &&
            Object.keys(declaration.parameters.properties).length === 0
          ) {
            delete declaration.parameters;
          }
        }
        declarations.push(declaration);
      } else if (isRecord(tool[tool.type])) {
        custom.push({ [tool.type]: tool[tool.type] });
      }
    }
    if (declarations.length > 0) tools.push({ function_declarations: declarations });
    else tools.push(...custom);
  }
  if (request.enable_web_search && !imageOutput && !gemma3 && !learnLm && !noSearch) {
    if (!tools.some((tool) => Array.isArray(tool.function_declarations))) {
      tools.push({ google_search: {} });
    }
  }
  return tools;
}

function toolChoiceConfig(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const modes: Record<string, string> = { none: 'NONE', required: 'ANY', auto: 'AUTO' };
    return modes[value] ? { mode: modes[value] } : null;
  }
  if (isRecord(value) && isRecord(value.function) && typeof value.function.name === 'string') {
    return { mode: 'ANY', allowedFunctionNames: [value.function.name] };
  }
  return null;
}

function isThinkingModel(model: string): boolean {
  return (
    (/^gemini-2\.5-(flash|pro)/u.test(model) && !/-image(-preview)?$/u.test(model)) ||
    /^gemini-3[.\d]*-(flash|pro)/u.test(model)
  );
}

function cloneMessages(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new GenerationProviderError(
      'invalid-request',
      'Chat completion messages are required.',
      400,
    );
  }
  return structuredClone(value) as Array<Record<string, unknown>>;
}

function promptNames(request: Record<string, unknown>) {
  const groupNames = Array.isArray(request.group_names) ? request.group_names.map(String) : [];
  return {
    charName: String(request.char_name ?? ''),
    userName: String(request.user_name ?? ''),
    groupNames,
    startsWithGroupName(message: string) {
      return groupNames.some((name) => message.startsWith(`${name}: `));
    },
  };
}

function hasReverseProxy(request: Record<string, unknown>): boolean {
  return typeof request.reverse_proxy === 'string' && Boolean(request.reverse_proxy.trim());
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GenerationProviderError('invalid-request', `${label} is required.`, 400);
  }
  return value;
}

function responseWithJson(upstream: Response, data: unknown): Response {
  const headers = new Headers(upstream.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
