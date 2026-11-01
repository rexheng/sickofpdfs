/**
 * A hybrid logical clock stamp: `${ms padded to 13}-${counter in hex padded to 4}-${deviceId}`.
 * Only the type is here for now; the `Hlc` class and `compareHlc` come with the local store (Phase 1 Task 28).
 */
export type HlcStamp = string;
