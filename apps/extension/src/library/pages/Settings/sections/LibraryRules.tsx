// Settings → Library rules (plan S14; spec "Settings has the allow and deny lists, with suggestions such as moodle.lse.ac.uk
// that you switch on yourself"). The two lists are the synced settings `filter.allow` and `filter.deny` (contracts §5).
//
// R91: the owner's rules can only make the filter more careful. An entry R91 refuses is refused here, in plain words, before
// it is sent; the store checks it again. An entry already stored that R91 refuses (it came by sync) is shown as "not used".
// The never-save count comes from this computer's private store; the list itself is salted fingerprints, never shown.
import { type ListKind, listEntryProblem } from '@sop/core';
import { Icon, IconButton, TextButton, TextField } from '@sop/ui';
import { Switch } from '@sop/ui/library';
import { useCallback, useEffect, useState } from 'react';
import { useLibrary } from '../../../app/context';
import type { LibraryData, LibraryItem } from '../../../data/types';
import { neverSaveCount } from '../../../settings/never-save';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import styles from './sections.module.css';
import { type RuleSuggestion, ruleSuggestions } from './rule-suggestions';

const KEYS: Record<ListKind, string> = { allow: 'filter.allow', deny: 'filter.deny' };
const LIST_NAMES: Record<ListKind, string> = { allow: 'Save from these places', deny: 'Never save from these places' };
/** The most readings read for the suggestions. */
const SUGGESTION_SCAN = 1000;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A folder on this computer (a drive, a network share, a rooted path or a file link), not a site. */
const isFolder = (entry: string): boolean => /^([a-z]:([\\/]|$)|\\\\|\/|file:)/i.test(entry.trim());

/** The plain words after the store's code: "bad-input: this can’t be on the allow list: a whole drive" → "a whole drive". */
function storeProblem(e: unknown): string | null {
  const message = e instanceof Error ? e.message : '';
  if (!message.startsWith('bad-input')) return null;
  return message.slice(message.lastIndexOf(': ') + 2) || null;
}

/** Every saved reading, a page at a time, up to SUGGESTION_SCAN. */
async function allReadings(data: LibraryData): Promise<LibraryItem[]> {
  const out: LibraryItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await data.listDocuments({ view: 'all', sort: { by: 'lastOpened', dir: 'desc' }, limit: 200, ...(cursor !== undefined ? { cursor } : {}) });
    out.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && out.length < SUGGESTION_SCAN);
  return out;
}

export function LibraryRulesSection() {
  const { data, notify } = useLibrary();
  const [lists, setLists] = useState<Record<ListKind, string[]> | null>(null);
  const [failed, setFailed] = useState(false);
  const [never, setNever] = useState<number | null>(null);
  const [readings, setReadings] = useState<LibraryItem[]>([]);

  const reload = useCallback(async () => {
    const [allow, deny] = await Promise.all([data.getSetting(KEYS.allow), data.getSetting(KEYS.deny)]);
    setLists({ allow: strings(allow), deny: strings(deny) });
    setFailed(false);
  }, [data]);

  useEffect(() => {
    reload().catch(() => setFailed(true));
    neverSaveCount().then(setNever, () => setNever(null));
    allReadings(data).then(setReadings, () => setReadings([]));
  }, [data, reload]);

  /** Adds an entry; answers the words to show when it cannot be added, or null. */
  const add = useCallback(
    async (list: ListKind, raw: string): Promise<string | null> => {
      const entry = raw.trim();
      if (entry === '') return null;
      const current = lists?.[list] ?? [];
      if (current.some((e) => e.trim().toLowerCase() === entry.toLowerCase())) return `“${entry}” is already on this list.`;
      const problem = listEntryProblem(entry, list);
      if (problem !== null) return `Can’t add “${entry}”: it is ${problem}.${list === 'allow' && listEntryProblem(entry, 'deny') === null ? ' Add the site or folder of one course instead.' : ''}`;
      try {
        const now = await data.addToSettingList(KEYS[list], entry);
        setLists((l) => (l === null ? l : { ...l, [list]: now }));
        return null;
      } catch (e) {
        const why = storeProblem(e);
        return why === null ? 'Couldn’t add it. Try again.' : `Can’t add “${entry}”: it is ${why}.`;
      }
    },
    [data, lists],
  );

  const remove = useCallback(
    (list: ListKind, entry: string) => {
      const next = (lists?.[list] ?? []).filter((e) => e !== entry);
      data.setSetting(KEYS[list], next).then(
        () => {
          setLists((l) => (l === null ? l : { ...l, [list]: next }));
          notify({
            text: `Removed ${entry}`,
            action: { label: 'Undo', onClick: () => void data.addToSettingList(KEYS[list], entry).then(() => reload(), () => notify({ text: 'That didn’t work. Try again.' })) },
          });
        },
        () => notify({ text: 'Couldn’t remove it. Try again.' }),
      );
    },
    [data, lists, notify, reload],
  );

  const suggestions = lists === null ? [] : ruleSuggestions(readings, lists.allow, lists.deny);

  return (
    <SettingsSection
      id="rules"
      title="Library rules"
      intro="The filter decides which PDFs are for learning and saves them. These rules help it decide. Receipts, bank papers and other private documents are never saved, whatever the rules say."
    >
      {failed && (
        <p className={styles.problem} role="alert">
          Couldn’t read your rules. <TextButton label="Try again" onClick={() => void reload().catch(() => setFailed(true))} />
        </p>
      )}
      {lists !== null && (
        <>
          <RuleList
            list="allow"
            entries={lists.allow}
            description="When the filter isn’t sure about a PDF from one of these sites or folders, it saves it."
            placeholder="A site or folder, such as moodle.lse.ac.uk"
            onAdd={(e) => add('allow', e)}
            onRemove={(e) => remove('allow', e)}
            suggestions={suggestions}
            onSuggestion={(s) =>
              void add('allow', s.entry).then((problem) => notify({ text: problem ?? `Added ${s.entry} to “${LIST_NAMES.allow}”` }))
            }
          />
          <RuleList
            list="deny"
            entries={lists.deny}
            description="PDFs from these sites and folders are never saved on their own. You can still save one yourself."
            placeholder="A site or folder, such as mybank.co.uk"
            onAdd={(e) => add('deny', e)}
            onRemove={(e) => remove('deny', e)}
          />
        </>
      )}
      <SettingsGroup id="rules-never" title="Files you chose never to save">
        <SettingsRow
          icon={<Icon name="block" size={20} />}
          label={never === null ? '…' : never === 0 ? 'None' : never === 1 ? '1 file' : `${never} files`}
          value="To save one after all, open it and choose Save to library. This list stays on this computer and is never backed up."
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

interface RuleListProps {
  list: ListKind;
  entries: readonly string[];
  description: string;
  placeholder: string;
  onAdd(this: void, entry: string): Promise<string | null>;
  onRemove(this: void, entry: string): void;
  suggestions?: readonly RuleSuggestion[];
  onSuggestion?(this: void, s: RuleSuggestion): void;
}

/** One list: its entries with Remove, a field to add one, and (for the "save from" list) the suggestions. */
function RuleList({ list, entries, description, placeholder, onAdd, onRemove, suggestions = [], onSuggestion }: RuleListProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = LIST_NAMES[list];
  const errorId = `rules-${list}-error`;

  const submit = async (): Promise<void> => {
    if (busy || text.trim() === '') return;
    setBusy(true);
    const problem = await onAdd(text);
    setBusy(false);
    setError(problem);
    if (problem === null) setText('');
  };

  return (
    <SettingsGroup id={`rules-${list}`} title={name} description={description}>
      {entries.length === 0 && <SettingsRow label="No places yet" />}
      {entries.map((entry) => {
        const problem = listEntryProblem(entry, list);
        return (
          <SettingsRow
            key={entry}
            icon={<Icon name={isFolder(entry) ? 'folder' : 'language'} size={20} />}
            label={entry}
            problem={problem === null ? undefined : `Not used: it is ${problem}.`}
            actions={<IconButton icon="close" label={`Remove ${entry}`} size={40} iconSize={20} onClick={() => onRemove(entry)} />}
          />
        );
      })}
      <div className={styles.addRow}>
        <div className={styles.addField}>
          <TextField
            value={text}
            onChange={(v) => {
              setText(v);
              if (error !== null) setError(null);
            }}
            onEnter={() => void submit()}
            label={`Add to “${name}”`}
            placeholder={placeholder}
            invalid={error !== null}
            aria-describedby={error !== null ? errorId : undefined}
            spellCheck={false}
          />
          {error !== null && (
            <span id={errorId} className={styles.fieldError} role="alert">
              <Icon name="error" size={20} />
              <span>{error}</span>
            </span>
          )}
        </div>
        <TextButton label="Add" aria-label={`Add to “${name}”`} disabled={busy || text.trim() === ''} onClick={() => void submit()} />
      </div>
      {suggestions.length > 0 && (
        <>
          <p className={styles.caption}>Suggested from your library</p>
          {suggestions.map((s) => (
            <SettingsRow
              key={s.entry}
              icon={<Icon name={s.kind === 'folder' ? 'folder' : 'language'} size={20} />}
              label={s.entry}
              value={`${s.readings} readings saved from here`}
              actions={<Switch checked={false} aria-label={`Save from ${s.entry}`} onChange={() => onSuggestion?.(s)} />}
            />
          ))}
        </>
      )}
    </SettingsGroup>
  );
}
