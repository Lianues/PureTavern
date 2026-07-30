/// <reference lib="webworker" />

import { analyzeWithTokenx, countWithTokenx } from '../application/tokenx-engine';

const PROTOCOL = 'pure-tavern-tokenizer/1';

type WorkerRequest = {
  protocol: typeof PROTOCOL;
  id: number;
  operation: 'count' | 'analyze';
  text: string;
};

type WorkerResponse =
  | {
      protocol: typeof PROTOCOL;
      id: number;
      ok: true;
      count: number;
      chunks?: string[];
    }
  | {
      protocol: typeof PROTOCOL;
      id: number;
      ok: false;
      error: string;
    };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (
    !request ||
    request.protocol !== PROTOCOL ||
    !['count', 'analyze'].includes(request.operation) ||
    !Number.isSafeInteger(request.id)
  ) {
    return;
  }

  let response: WorkerResponse;
  try {
    if (request.operation === 'count') {
      response = {
        protocol: PROTOCOL,
        id: request.id,
        ok: true,
        count: countWithTokenx(request.text),
      };
    } else {
      const result = analyzeWithTokenx(request.text);
      response = { protocol: PROTOCOL, id: request.id, ok: true, ...result };
    }
  } catch (error) {
    response = {
      protocol: PROTOCOL,
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  scope.postMessage(response);
});
