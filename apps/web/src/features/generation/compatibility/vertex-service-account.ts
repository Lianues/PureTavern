import { GenerationProviderError } from '../domain/provider';
import type { ProviderHttpClient } from '../ports/provider-http-client';
import { isRecord } from './upstream-utils';

const TOKEN_URL = new URL('https://oauth2.googleapis.com/token');
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface VertexAccessToken {
  accessToken: string;
  projectId: string;
}

export async function exchangeVertexServiceAccount(
  rawServiceAccount: string,
  client: ProviderHttpClient,
  signal?: AbortSignal,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VertexAccessToken> {
  const account = parseServiceAccount(rawServiceAccount);
  const jwt = await createServiceAccountJwt(account, nowSeconds);
  const response = await client.send('vertexai', TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
    signal: signal ?? null,
  });
  if (!response.ok) {
    throw new GenerationProviderError(
      'provider-error',
      `Vertex AI OAuth token exchange returned HTTP ${response.status}.`,
      response.status,
    );
  }
  let data: unknown;
  try {
    data = (await response.json()) as unknown;
  } catch (error) {
    throw new GenerationProviderError(
      'invalid-response',
      'Vertex AI OAuth token exchange returned invalid JSON.',
      502,
      { cause: error },
    );
  }
  if (!isRecord(data) || typeof data.access_token !== 'string' || !data.access_token) {
    throw new GenerationProviderError(
      'invalid-response',
      'Vertex AI OAuth token response is missing access_token.',
      502,
    );
  }
  return { accessToken: data.access_token, projectId: account.projectId };
}

interface ParsedServiceAccount {
  clientEmail: string;
  privateKey: string;
  projectId: string;
}

function parseServiceAccount(value: string): ParsedServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new GenerationProviderError(
      'invalid-request',
      'Vertex AI Service Account must be valid JSON.',
      400,
      { cause: error },
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.client_email !== 'string' ||
    typeof parsed.private_key !== 'string' ||
    typeof parsed.project_id !== 'string' ||
    !parsed.client_email ||
    !parsed.private_key ||
    !parsed.project_id
  ) {
    throw new GenerationProviderError(
      'invalid-request',
      'Vertex AI Service Account JSON is missing client_email, private_key or project_id.',
      400,
    );
  }
  return {
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
    projectId: parsed.project_id,
  };
}

async function createServiceAccountJwt(
  account: ParsedServiceAccount,
  nowSeconds: number,
): Promise<string> {
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iss: account.clientEmail,
    scope: TOKEN_SCOPE,
    aud: TOKEN_URL.toString(),
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
  const signingInput = `${header}.${payload}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(account.privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch (error) {
    throw new GenerationProviderError(
      'invalid-request',
      'Vertex AI Service Account private_key is not a valid PKCS#8 RSA key.',
      400,
      { cause: error },
    );
  }
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function pemToArrayBuffer(value: string): ArrayBuffer {
  const base64 = value
    .replace(/-----BEGIN PRIVATE KEY-----/gu, '')
    .replace(/-----END PRIVATE KEY-----/gu, '')
    .replace(/\s/gu, '');
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}
