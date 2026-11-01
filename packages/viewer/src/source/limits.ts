/**
 * The largest PDF this viewer opens: 1 GiB (Task 10's decision, `MAX_OPEN_BYTES`). A larger file opens in Chrome's own
 * viewer with a note (spec: "Up to 1 GB opens normally; larger files ... open in Chrome's viewer with a note").
 */
export const MAX_OPEN_BYTES = 1_073_741_824;
