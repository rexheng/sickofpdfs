import { type ReactNode, useRef } from 'react';

/**
 * A hidden `<input type="file" accept="application/pdf">` and a function that opens it. The input stays in the DOM,
 * so the person's choice (or a test's setInputFiles) reaches `onFile`.
 */
export function useFilePicker(onFile: (file: File) => void): { input: ReactNode; open: () => void } {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept="application/pdf"
      hidden
      onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = ''; // the same file can be chosen again
        if (file) onFile(file);
      }}
    />
  );
  return { input, open: () => ref.current?.click() };
}
