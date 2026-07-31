# M12 Generation Providers / Chat Completion only

This feature migrates only SillyTavern's `main_api="openai"` Chat Completion transport. The unchanged upstream `openai.js` and Legacy Prompt Pipeline continue to build `generate_data` and parse provider responses.

## Provider architecture

The 26 upstream `chat_completion_sources` are represented by one audited descriptor registry and four protocol adapters:

- OpenAI-compatible: OpenAI, OpenRouter, AI21, Mistral, Custom, Perplexity, Groq, ElectronHub, Chutes, NanoGPT, DeepSeek, AI/ML API, xAI, Pollinations, Moonshot, Fireworks, CometAPI, Azure OpenAI, Z.AI, SiliconFlow, Workers AI and MiniMax.
- Anthropic: Claude.
- Google: AI Studio and Vertex AI Express.
- Cohere: v2 Chat.

The module ports are `GenerationGateway`, `ModelCatalogGateway` and `StreamingGeneration`. Credentials are resolved just in time through M14's narrow capability. Keys are never added to diagnostics or provider request bodies.

## Generation transport modes

PureTavern injects a transport selector above Legacy Connection Manager's `#connection_profiles` row without changing the upstream template:

- **Current frontend call** keeps the existing direct browser request behavior.
- **Local backend call** appears only when a host shell injects the versioned `pure-tavern-local-backend` bridge. The Web feature knows only this narrow port: Android's Capacitor adapter lives in `apps/mobile`, while the Tauri adapter lives in `apps/desktop`. Plain Web and shells without an adapter omit the option. Provider adaptation and response parsing stay in this frontend module.
- **Remote backend call** sends the final provider URL, headers and JSON body to the optional PureTavern proxy protocol. Provider adaptation and response parsing remain in this frontend module; the backend is transport-only.

The remote backend URL, access key, selected mode and connection result are session-memory state. They are deliberately not written to IndexedDB, localStorage, Legacy settings or diagnostics in this phase. The health endpoint must identify protocol `pure-tavern-generation-proxy` version 1 before requests are enabled. Local and remote modes both rebuild standard `Response` objects and preserve JSON and SSE streaming.

Remote reference implementations live in `apps/remote-server`; native transports and their shell-only adapters live in `apps/mobile/android/local-server` and `apps/desktop`. Direct mode can still fail because of CORS, TLS, Private Network Access or vendor policy; these failures remain reported as `cors-or-network`. Android and desktop local modes bypass browser CORS through their native bridges and permit user-configured HTTP LAN providers, but HTTPS is strongly preferred. Remote mode requires the proxy itself to be reachable and CORS-enabled. An HTTPS page may not call an HTTP LAN proxy because of Mixed Content/PNA, so production Web deployments need an HTTPS backend.

Custom and reverse-proxy provider URLs must still use HTTPS, except localhost/127.0.0.1 development URLs. The remote backend access key authenticates the proxy and is separate from the provider credentials carried inside the encrypted HTTPS request.

Vertex AI service-account auth is not enabled because a browser-only token exchange is not a reliable security or CORS boundary. Vertex Express API-key mode is supported. Advanced provider-specific multimodal, cache, reasoning-signature and beta tool combinations may return an explicit capability error; text Chat Completion, basic tools, non-streaming and SSE are the compatibility baseline.

## Honest logit-bias boundary

M15 tokenx IDs are pseudo IDs. M12 accepts only explicit numeric arrays such as `[123,456]` for bias maps. Text bias entries are skipped and diagnostics count them as requiring an exact model tokenizer.

## Not migrated

Text Completion, NovelAI, AI Horde, KoboldAI, WebLLM and all optional backend functions remain outside this feature. Their original DOM options are preserved for compatibility, but no successful capability is claimed.
