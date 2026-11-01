// What the offscreen document and the backup worker say to each other (host.ts, worker.ts).
//
//   worker → host   { type: 'backup:port-request' }          "give me a new port to the store worker"
//   host   → worker { type: 'backup:port' } + the port       the answer (the host made a channel and gave one end to the store worker)
//   worker → host   { type: 'backup:badge', waiting }        "show or clear the badge on the toolbar icon"
export const WORKER_PORT_REQUEST = 'backup:port-request';
export const WORKER_PORT = 'backup:port';
export const WORKER_BADGE = 'backup:badge';

export const isHostMessage = (x: unknown, type: string): boolean => typeof x === 'object' && x !== null && (x as { type?: unknown }).type === type;
