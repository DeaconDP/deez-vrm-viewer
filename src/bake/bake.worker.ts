/// <reference lib="webworker" />
import { BakeError, bakeVrm } from './meshBaker';
import type { BakeWorkerRequest, BakeWorkerResponse } from './types';

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<BakeWorkerRequest>) => {
  if (event.data.type !== 'start') return;
  try {
    const result = bakeVrm(event.data.buffer, event.data.fileName, (stage, progress, detail, stats) => {
      scope.postMessage({ type: 'progress', stage, progress, detail, stats } satisfies BakeWorkerResponse);
    }, event.data.options);
    scope.postMessage({ type: 'complete', ...result } satisfies BakeWorkerResponse, [result.buffer]);
  } catch (reason) {
    const error = reason instanceof BakeError
      ? { code: reason.code, message: reason.message }
      : { code: 'BAKE_FAILED', message: reason instanceof Error ? reason.message : String(reason) };
    scope.postMessage({ type: 'error', ...error } satisfies BakeWorkerResponse);
  }
};

export {};
