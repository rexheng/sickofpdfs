// What the offscreen document and the categoriser worker say to each other (host.ts, worker.ts).
//
//   worker → host   { type: 'categorise:port-request' }   "give me a new port to the store worker"
//   host   → worker { type: 'categorise:port' } + the port   the answer (the host made a channel and gave one end to the store worker)
export const WORKER_PORT_REQUEST = 'categorise:port-request';
export const WORKER_PORT = 'categorise:port';

export const isHostMessage = (x: unknown, type: string): boolean => typeof x === 'object' && x !== null && (x as { type?: unknown }).type === type;
