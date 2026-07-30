export interface UpstreamGenerationConfig {
  promptPlaceholder: string;
  claude: {
    enableSystemPromptCache: boolean;
    cachingAtDepth: number;
    extendedTTL: boolean;
    enableAdaptiveThinking: boolean;
  };
  gemini: {
    apiVersion: 'v1beta' | 'v1alpha';
    thoughtSignatures: boolean;
    enableSystemPromptCache: boolean;
  };
  mistral: {
    enablePrefix: boolean;
  };
  openai: {
    randomizeUserId: boolean;
  };
}

/** SillyTavern 1.18.0/default/config.yaml defaults. */
export const DEFAULT_UPSTREAM_GENERATION_CONFIG: Readonly<UpstreamGenerationConfig> = {
  promptPlaceholder: "Let's get started.",
  claude: {
    enableSystemPromptCache: false,
    cachingAtDepth: -1,
    extendedTTL: false,
    enableAdaptiveThinking: false,
  },
  gemini: {
    apiVersion: 'v1beta',
    thoughtSignatures: true,
    enableSystemPromptCache: false,
  },
  mistral: {
    enablePrefix: false,
  },
  openai: {
    randomizeUserId: false,
  },
};

let activeConfig: UpstreamGenerationConfig = structuredClone(DEFAULT_UPSTREAM_GENERATION_CONFIG);

export function getUpstreamGenerationConfig(): Readonly<UpstreamGenerationConfig> {
  return activeConfig;
}

export function getUpstreamConfigValue<T>(path: string, fallback: T): T {
  let value: unknown = activeConfig;
  for (const segment of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    value = (value as Record<string, unknown>)[segment];
  }
  return value === undefined ? fallback : (value as T);
}

/** Test/runtime composition hook; defaults remain identical to upstream config.yaml. */
export function setUpstreamGenerationConfigForTesting(
  config: UpstreamGenerationConfig,
): () => void {
  const previous = activeConfig;
  activeConfig = structuredClone(config);
  return () => {
    activeConfig = previous;
  };
}
