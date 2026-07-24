/// <reference lib="webworker" />

import { analyzeWithTokenx } from '../application/tokenx-engine';

const PROTOCOL = 'pure-tavern-tokenizer/1';

type WorkerRequest = {
  protocol: typeof PROTOCOL;
  id: number;
  operation: 'analyze';
  text: string;
};

type WorkerResponse =
  | {
      protocol: typeof PROTOCOL;
      id: number;
      ok: true;
      count: number;
      chunks: string[];
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
    request.operation !== 'analyze' ||
    !Number.isSafeInteger(request.id)
  ) {
    return;
  }

  let response: WorkerResponse;
  try {
    const result = analyzeWithTokenx(request.text);
    response = { protocol: PROTOCOL, id: request.id, ok: true, ...result };
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
