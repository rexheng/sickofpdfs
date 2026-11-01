export function fetchThing(): Promise<void> {
  return Promise.resolve();
}

export async function useThing(): Promise<number> {
  await fetchThing();
  return 1;
}
