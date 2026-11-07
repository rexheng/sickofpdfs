// What the offscreen page (host.ts) and its OCR worker (bg-worker.ts) say to each other:
//   worker → host   { type: 'ocr:port-request' }               "give me a new port to the store worker"
//   host   → worker { type: 'ocr:port' } + the port
//   host   → worker { type: 'ocr:job', documentId, visible, direction }   read this saved reading (it skips what is done)
//   worker → host   { type: 'ocr:finished', documentId }       nothing is left to read in it (or it cannot be read)
//   worker → host   { type: 'ocr:idle' }                       no reading is left: the host may end the worker
export const WORKER_PORT_REQUEST = 'ocr:port-request';
export const WORKER_PORT = 'ocr:port';
export const WORKER_JOB = 'ocr:job';
export const WORKER_FINISHED = 'ocr:finished';
export const WORKER_IDLE = 'ocr:idle';

export const isWorkerMessage = (x: unknown, type: string): boolean => typeof x === 'object' && x !== null && (x as { type?: unknown }).type === type;
