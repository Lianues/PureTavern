import { estimateTokenCount } from 'tokenx';
import { describe, expect, it } from 'vitest';

import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';

import { TokenizerService } from '../application/tokenizer-service';
import { registerTokenizerLegacyRoutes, TOKENIZER_ALIASES } from '../legacy/register-routes';

describe('M15 Legacy tokenizer routes', () => {
  it('maps every model alias to the same tokenx estimate', async () => {
    const { router } = createHarness();
    const text = 'One unified tokenizer 你好 👋';
    const expected = estimateTokenCount(text);

    for (const alias of TOKENIZER_ALIASES) {
      const response = await post(router, `/api/tokenizers/${alias}/encode`, { text });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        count: expected,
        approximate: true,
        precision: 'approximate',
        tokenizer: 'tokenx',
      });
    }
  });

  it('supports pseudo encode/decode for the current page session', async () => {
    const { router } = createHarness();
    const text = 'Decode this estimated token sequence.';
    const encoded = await (await post(router, '/api/tokenizers/llama/encode', { text })).json();
    const decoded = await post(router, '/api/tokenizers/llama/decode', { ids: encoded.ids });

    await expect(decoded.json()).resolves.toMatchObject({
      text,
      supported: true,
      approximate: true,
      tokenizer: 'tokenx',
    });
    const unknown = await post(router, '/api/tokenizers/gpt2/decode', { ids: [1, 2, 3] });
    await expect(unknown.json()).resolves.toMatchObject({
      text: '',
      chunks: [],
      supported: false,
    });
  });

  it('counts opaque OpenAI message bodies and handles remote aliases locally', async () => {
    const { router } = createHarness();
    const count = await post(router, '/api/tokenizers/openai/count?model=anything', [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ]);
    await expect(count.json()).resolves.toMatchObject({
      token_count: expect.any(Number),
      approximate: true,
      tokenizer: 'tokenx',
    });

    for (const path of [
      '/api/tokenizers/remote/kobold/count',
      '/api/tokenizers/remote/textgenerationwebui/encode',
    ]) {
      const response = await post(router, path, { text: 'No remote request is made.' });
      await expect(response.json()).resolves.toMatchObject({
        count: estimateTokenCount('No remote request is made.'),
        approximate: true,
      });
    }
  });

  it('provides the same DTO through the narrow synchronous compatibility registry', () => {
    const { router } = createHarness();
    const text = 'Synchronous token counter';
    const encoded = router.dispatchSync(
      'POST',
      new URL('https://app.example/api/tokenizers/mistral/encode'),
      JSON.stringify({ text }),
    );
    expect(encoded.status).toBe(200);
    const payload = JSON.parse(encoded.body);
    expect(payload).toMatchObject({
      count: estimateTokenCount(text),
      approximate: true,
      tokenizer: 'tokenx',
    });

    const decoded = router.dispatchSync(
      'POST',
      new URL('https://app.example/api/tokenizers/mistral/decode'),
      JSON.stringify({ ids: payload.ids }),
    );
    expect(JSON.parse(decoded.body)).toMatchObject({ text, supported: true });
  });
});

function createHarness() {
  const router = new CompatibilityRouter();
  const tokenizer = new TokenizerService();
  registerTokenizerLegacyRoutes(router, tokenizer);
  return { router, tokenizer };
}

async function post(router: CompatibilityRouter, path: string, body: unknown): Promise<Response> {
  const request = new Request(`https://app.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await router.dispatch(request, new URL(request.url));
  if (!response) throw new Error(`Route was not handled: ${path}`);
  return response;
}
