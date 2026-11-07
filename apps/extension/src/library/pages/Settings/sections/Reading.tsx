// Settings → Reading: the reading aids that are remembered on this computer (chrome.storage.local), so every viewer tab follows
// a change at once. The keys are the features' own (coordinated by name):
// - `view.boldWordStarts`: R90 Bold word starts, true or false (the View menu's switch, word-starts.ts);
// - `view.boldWordStartsStrength`: R90's strength, 'light', 'medium' (the rule as written) or 'strong'; missing means medium;
// - `view.caretBrowsing`: R93 Caret browsing, true or false.
// Phase 7.5 adds "Scanned PDFs" (library/settings/OcrSection.tsx): reading the text of scans, kept in the library's settings.
import { Switch } from '@sop/ui/library';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { ScanReadingGroup } from '../../../settings/OcrSection';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import styles from './sections.module.css';

export const WORD_STARTS_KEY = 'view.boldWordStarts';
export const WORD_STARTS_STRENGTH_KEY = 'view.boldWordStartsStrength';
export const CARET_BROWSING_KEY = 'view.caretBrowsing';

export type Strength = 'light' | 'medium' | 'strong';
const STRENGTHS: readonly { value: Strength; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong' },
];

const asSwitch = (v: unknown): boolean => v === true;
const asStrength = (v: unknown): Strength => (v === 'light' || v === 'strong' ? v : 'medium');

/** A value kept in chrome.storage.local, followed live (another tab, or the viewer's View menu, may change it). */
function useLocalValue<T>(key: string, read: (v: unknown) => T): [T | null, (v: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    chrome.storage.local.get(key).then(
      (stored) => live && setValue(read(stored[key])),
      () => live && setValue(read(undefined)),
    );
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const change = changes[key];
      if (area === 'local' && change !== undefined) setValue(read(change.newValue));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [key, read]);
  const set = (v: T) => {
    setValue(v);
    void chrome.storage.local.set({ [key]: v }).catch(() => {});
  };
  return [value, set];
}

export function ReadingSection() {
  const [wordStarts, setWordStarts] = useLocalValue(WORD_STARTS_KEY, asSwitch);
  const [strength, setStrength] = useLocalValue(WORD_STARTS_STRENGTH_KEY, asStrength);
  const [caret, setCaret] = useLocalValue(CARET_BROWSING_KEY, asSwitch);
  const off = wordStarts !== true;

  return (
    <SettingsSection id="reading" title="Reading" intro="Aids for reading in the viewer. They work in every PDF and are remembered on this computer.">
      <SettingsGroup id="reading-aids" title="While you read">
        <SettingsRow
          label="Bold word starts"
          labelId="reading-word-starts"
          value="The first part of every word is drawn bold, to guide your eye along the line. Turn it on or off in the View menu too."
          actions={<Switch checked={wordStarts === true} disabled={wordStarts === null} aria-labelledby="reading-word-starts" onChange={setWordStarts} />}
        />
        <SettingsRow
          inset
          muted={off}
          label="How bold"
          labelId="reading-strength"
          value="Medium is the usual. Light is gentler; Strong stands out more."
          actions={<StrengthChoice value={strength ?? 'medium'} disabled={off} onChange={setStrength} />}
        />
        <SettingsRow
          label="Caret browsing"
          labelId="reading-caret"
          value="A text cursor you move with the arrow keys, to read and select text with the keyboard."
          actions={<Switch checked={caret === true} disabled={caret === null} aria-labelledby="reading-caret" onChange={setCaret} />}
        />
      </SettingsGroup>
      <ScanReadingGroup />
    </SettingsSection>
  );
}

/** Light, Medium or Strong: a radio group drawn as one outlined segmented button. The arrow keys move the choice. */
function StrengthChoice({ value, disabled, onChange }: { value: Strength; disabled: boolean; onChange(this: void, v: Strength): void }) {
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 || disabled) return;
    e.preventDefault();
    const at = STRENGTHS.findIndex((s) => s.value === value);
    const next = STRENGTHS[(at + step + STRENGTHS.length) % STRENGTHS.length];
    if (next === undefined) return;
    onChange(next.value);
    const group = e.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div className={styles.segments} role="radiogroup" aria-labelledby="reading-strength" onKeyDown={move}>
      {STRENGTHS.map((s) => (
        <button
          key={s.value}
          type="button"
          role="radio"
          aria-checked={s.value === value}
          tabIndex={s.value === value ? 0 : -1}
          disabled={disabled}
          className={styles.segment}
          onClick={() => onChange(s.value)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
