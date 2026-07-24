# M12 Generation Providers / Chat Completion only

This feature migrates only SillyTavern's `main_api="openai"` Chat Completion transport. The unchanged upstream `openai.js` and Legacy Prompt Pipeline continue to build `generate_data` and parse provider responses.

## Provider architecture

The 26 upstream `chat_completion_sources` are represented by one audited descriptor registry and four protocol adapters:

- OpenAI-compatible: OpenAI, OpenRouter, AI21, Mistral, Custom, Perplexity, Groq, ElectronHub, Chutes, NanoGPT, DeepSeek, AI/ML API, xAI, Pollinations, Moonshot, Fireworks, CometAPI, Azure OpenAI, Z.AI, SiliconFlow, Workers AI and MiniMax.
- Anthropic: Claude.
- Google: AI Studio and Vertex AI Express.
- Cohere: v2 Chat.

The module ports are `GenerationGateway`, `ModelCatalogGateway` and `StreamingGeneration`. Credentials are resolved just in time through M14's narrow capability. Keys are never added to diagnostics or provider request bodies.

## Browser limits

This project does not provide a CORS proxy, Vault or private-network bridge. A provider can be implemented correctly and still reject browser requests because of CORS, TLS, Private Network Access or vendor policy. Such failures are reported as `cors-or-network` and are not disguised as successful responses.

Custom and reverse-proxy URLs must use HTTPS, except localhost/127.0.0.1 development URLs. A user-supplied reverse proxy is merely a direct target; it is not a Pure Tavern optional backend.

Vertex AI service-account auth is not enabled because a browser-only token exchange is not a reliable security or CORS boundary. Vertex Express API-key mode is supported. Advanced provider-specific multimodal, cache, reasoning-signature and beta tool combinations may return an explicit capability error; text Chat Completion, basic tools, non-streaming and SSE are the compatibility baseline.

## Honest logit-bias boundary

M15 tokenx IDs are pseudo IDs. M12 accepts only explicit numeric arrays such as `[123,456]` for bias maps. Text bias entries are skipped and diagnostics count them as requiring an exact model tokenizer.

## Not migrated

Text Completion, NovelAI, AI Horde, KoboldAI, WebLLM and all optional backend functions remain outside this feature. Their original DOM options are preserved for compatibility, but no successful capability is claimed.
