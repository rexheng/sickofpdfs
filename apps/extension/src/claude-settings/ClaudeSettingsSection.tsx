// Settings → Claude (plan §4 slice G; spec "Claude integration" and Release 1 setup: "create an API key at console.anthropic.com
// with a monthly spend limit, and paste it into Settings"). One section of the Settings page's registry (settings/sections.ts).
//
// What the owner does here:
// - pastes the key once and presses "Check and save": one Models-list call checks it, and only then is it kept, in the
//   local-only store (key-check.ts). Afterwards it shows as "Key saved ····abcd", with Change key and Delete key;
// - picks the everyday and Think harder models from Anthropic's live list (Haiku and Opus are chosen for them at first), each with
//   its typical cost per question, and a warning before a chosen model retires;
// - turns web search on or off, sets the monthly limit and the "ask first" amount, and sees this month's spend.
//
// Opening this section sends nothing and reads no key: the list shown is the one last checked, kept on this computer.
import { type ModelChoice, type ModelRole, priceFor, typicalQuestionUsd } from '@sop/core';
import { DropdownMenu, Icon, type MenuItemDef, TextButton, TextField } from '@sop/ui';
import { Switch } from '@sop/ui/library';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useLibrary } from '../library/app/context';
import { formatDate } from '../library/components/format';
import { SettingsGroup, SettingsNote, SettingsRow, SettingsSection } from '../library/pages/Settings/SettingsSection';
import { getSpend, monthOf, type SpendRecord } from '../viewer/claude/spend';
import styles from './ClaudeSettingsSection.module.css';
import { type ApiProblem, cleanKey, deleteKey, keyShapeProblem, listModels, localStoreExists, readSavedKey, savedKeyEnding, saveKey } from './key-check';
import {
  CHOICE_SETTING, CLAUDE_SETTINGS, choosable, DEFAULT_CONFIRM_OVER_USD, DEFAULT_WEB_SEARCH, findListed, type ListedModel, type ModelList,
  parseModels, pickerGroups, preselect, probeWebSearchTool, readChoice, readSavedList, type Retirement, retirementOf, saveList, toChoice,
} from './model-discovery';

const CONSOLE_KEYS = 'https://console.anthropic.com/settings/keys';
const CONSOLE_LIMITS = 'https://console.anthropic.com/settings/limits';

/** Plain words for each way a call to Anthropic can fail. */
const PROBLEM_WORDS: Readonly<Record<ApiProblem, string>> = {
  'bad-key': 'That key didn’t work. Check that you copied all of it, or make a new key in the Anthropic Console.',
  'not-allowed': 'That key isn’t allowed to use Claude. Make a new key in the Anthropic Console.',
  'network': 'Couldn’t reach Anthropic. Check your internet, then try again.',
  'busy': 'Anthropic is busy right now. Wait a minute, then try again.',
  'server': 'Anthropic had a problem. Try again in a minute.',
};

/** The same, for the key that is already saved ("Check again" or a new model choice). */
const SAVED_KEY_WORDS: Readonly<Record<ApiProblem, string>> = {
  ...PROBLEM_WORDS,
  'bad-key': 'Your saved key doesn’t work any more. Change it, or make a new key in the Anthropic Console.',
  'not-allowed': 'Your saved key isn’t allowed to use Claude any more. Change it, or make a new key in the Anthropic Console.',
};

const ROLES: readonly { role: ModelRole; label: string; labelId: string; picked(this: void, name: string): string }[] = [
  { role: 'default', label: 'Everyday questions', labelId: 'claude-model-default', picked: (name) => `Everyday questions now use ${name}.` },
  { role: 'think-harder', label: 'Think harder', labelId: 'claude-model-think-harder', picked: (name) => `Think harder now uses ${name}.` },
];

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long' });
const LONG_DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' });
const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** "about 0.1 cent", "about 5 cents", "about $1.20": what a question costs, in the words of the spec. */
export function aboutCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return 'cost not known';
  const cents = usd * 100;
  if (cents < 0.1) return 'under 0.1 cent';
  if (cents < 0.95) return `about ${cents.toFixed(1)} cent`;
  if (cents < 1.5) return 'about 1 cent';
  if (cents < 99.5) return `about ${Math.round(cents)} cents`;
  return `about $${usd.toFixed(2)}`;
}

/** "$1.23"; an amount above zero but under a cent is "less than 1 cent". */
function money(usd: number): string {
  if (usd > 0 && usd < 0.005) return 'less than 1 cent';
  return `$${usd.toFixed(2)}`;
}

/** Whole nano-dollars, so a spend of exactly the limit counts as reaching it (cost.ts compares the same way). */
const nano = (usd: number) => Math.round(usd * 1e9);

/** "5", "$5", "2.50", "2,50": an amount in dollars, rounded to cents; null for an empty field; 'bad' for anything else. */
function parseUsd(text: string): number | null | 'bad' {
  const t = text.trim().replace(/^\$\s*/, '').replace(',', '.');
  if (t === '') return null;
  if (!/^\d{1,5}(\.\d{0,2})?$/.test(t)) return 'bad';
  return Math.round(Number(t) * 100) / 100;
}

const usdSetting = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The cost and abilities of a chosen model, in short sentences. */
function modelFacts(choice: ModelChoice, role: ModelRole): string {
  const price = priceFor(choice);
  const cost =
    price.basis === 'unknown-line'
      ? 'Its price isn’t known, so Claude asks before each question.'
      : `${capitalised(aboutCost(typicalQuestionUsd(choice, role)))} a question.`;
  return [cost, choice.imageInput ? 'Reads figures.' : 'Can’t read figures.', choice.webSearchTool !== null ? 'Can search the web.' : 'Doesn’t search the web.'].join(' ');
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function retirementWords(r: Retirement, name: string, now: number): string {
  if (r.kind === 'gone') return `${name} is no longer available. Pick another model.`;
  if (r.at === null) return `Anthropic is retiring ${name}. Pick another model soon.`;
  if (r.at <= now) return `Anthropic is retiring ${name} now. Pick another model.`;
  return `Anthropic retires ${name} on ${LONG_DATE.format(r.at)}. Pick another model before then.`;
}

function checkedWords(t: number, now: number): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return t >= today.getTime() ? `Checked today at ${TIME.format(t)}.` : `Checked on ${formatDate(t, now)}.`;
}

type Choices = Record<ModelRole, ModelChoice | null>;
type KeyState = { state: 'loading' } | { state: 'none' } | { state: 'saved'; ending: string };
type Check = { phase: 'idle' } | { phase: 'checking' } | { phase: 'failed'; message: string };

/**
 * The model a role starts with after a key check: the owner's earlier choice when this key's list still has it, else the one setup
 * picks (Haiku for everyday questions, Opus for Think harder). Its web search tool is probed with free token counting.
 */
async function setUpChoice(
  key: string,
  models: readonly ListedModel[],
  r: ModelRole,
  current: ModelChoice | null,
  now: number,
  probed: Map<ListedModel, string | null>,
): Promise<ModelChoice | null> {
  const kept = current === null ? undefined : findListed(models, current);
  const m = kept !== undefined && kept.lifecycle !== 'retired' ? kept : preselect(models, r);
  if (m === null) return null;
  if (!probed.has(m)) {
    const probe = await probeWebSearchTool(key, m);
    // A probe that could not finish keeps what was known for this model (nothing, for a new one); a new choice probes afresh.
    probed.set(m, probe.ok ? probe.tool : m === kept ? (current?.webSearchTool ?? null) : null);
  }
  return toChoice(m, probed.get(m) ?? null, now);
}

export function ClaudeSettingsSection() {
  const incognito = chrome.extension.inIncognitoContext;
  if (incognito) {
    return (
      <SettingsSection id="claude" title="Claude" intro="Ask Claude about what you read, in any note.">
        <SettingsNote icon={<Icon name="lock" size={20} />}>Claude isn’t available in an Incognito window. Open Settings in a normal window to add your key.</SettingsNote>
      </SettingsSection>
    );
  }
  return <ClaudeSettings />;
}

function ClaudeSettings() {
  const { data, notify } = useLibrary();
  const [key, setKey] = useState<KeyState>({ state: 'loading' });
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [check, setCheck] = useState<Check>({ phase: 'idle' });
  const [list, setList] = useState<ModelList | null>(null);
  const [choices, setChoices] = useState<Choices>({ 'default': null, 'think-harder': null });
  const [busyRole, setBusyRole] = useState<ModelRole | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProblem, setRefreshProblem] = useState<string | null>(null);
  const [webSearch, setWebSearch] = useState<boolean | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [confirmOver, setConfirmOver] = useState<number>(DEFAULT_CONFIRM_OVER_USD);
  const [spend, setSpend] = useState<SpendRecord | null>(null);
  const now = Date.now();

  const readSpend = useCallback(async () => {
    const month = monthOf(new Date());
    setSpend((await localStoreExists()) ? await getSpend().catch(() => ({ month, usd: 0 })) : { month, usd: 0 });
  }, []);

  // What this computer and the library already hold. Nothing here goes online.
  useEffect(() => {
    savedKeyEnding().then(
      (ending) => setKey(ending === null ? { state: 'none' } : { state: 'saved', ending }),
      () => setKey({ state: 'none' }),
    );
    readSavedList().then(setList, () => setList(null));
    const setting = (k: string) => data.getSetting(k).catch(() => null);
    void Promise.all([setting(CLAUDE_SETTINGS.modelDefault), setting(CLAUDE_SETTINGS.modelThinkHarder), setting(CLAUDE_SETTINGS.webSearch), setting(CLAUDE_SETTINGS.monthlyCapUsd), setting(CLAUDE_SETTINGS.confirmOverUsd)]).then(
      ([d, t, w, c, o]) => {
        setChoices({ 'default': readChoice(d), 'think-harder': readChoice(t) });
        setWebSearch(typeof w === 'boolean' ? w : DEFAULT_WEB_SEARCH);
        setCap(usdSetting(c));
        setConfirmOver(usdSetting(o) ?? DEFAULT_CONFIRM_OVER_USD);
      },
    );
    void readSpend();
    // a reply in a viewer tab adds to the spend: read it again when the owner comes back to this tab
    const onVisible = () => {
      if (document.visibilityState === 'visible') void readSpend();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [data, readSpend]);

  const saveChoice = useCallback(
    async (r: ModelRole, choice: ModelChoice): Promise<boolean> => {
      try {
        await data.setSetting(CHOICE_SETTING[r], choice);
        setChoices((c) => ({ ...c, [r]: choice }));
        return true;
      } catch {
        notify({ text: 'Couldn’t save your model choice. Try again.' });
        return false;
      }
    },
    [data, notify],
  );

  /** "Check and save": the one Models-list call, then the key is kept, then the models are set up. */
  const checkAndSave = async (): Promise<void> => {
    if (check.phase === 'checking') return;
    const pasted = cleanKey(draft);
    const shape = keyShapeProblem(pasted);
    if (shape !== null) return setCheck({ phase: 'failed', message: shape });
    setCheck({ phase: 'checking' });
    const answer = await listModels(pasted);
    if (!answer.ok) return setCheck({ phase: 'failed', message: PROBLEM_WORDS[answer.problem] });
    const models = parseModels(answer.value);
    if (choosable(models).length === 0) return setCheck({ phase: 'failed', message: 'Your key works, but Anthropic lists no Claude models for it yet. Try again later.' });
    try {
      await saveKey(pasted);
    } catch {
      return setCheck({ phase: 'failed', message: 'Couldn’t keep the key on this computer. Try again.' });
    }
    const at = Date.now();
    const next: ModelList = { checkedAt: at, models };
    await saveList(next);
    setList(next);
    const probed = new Map<ListedModel, string | null>();
    for (const { role: r } of ROLES) {
      const choice = await setUpChoice(pasted, models, r, choices[r], at, probed);
      if (choice !== null) await saveChoice(r, choice);
    }
    setKey({ state: 'saved', ending: pasted.slice(-4) });
    setDraft('');
    setEditing(false);
    setRefreshProblem(null);
    setCheck({ phase: 'idle' });
    notify({ text: 'Your key works. It is saved on this computer.' });
  };

  const removeKey = async (): Promise<void> => {
    try {
      await deleteKey();
      setKey({ state: 'none' });
      setDraft('');
      setCheck({ phase: 'idle' });
      notify({ text: 'Your Claude key is deleted from this computer.' });
    } catch {
      notify({ text: 'Couldn’t delete the key. Try again.' });
    }
  };

  /**
   * "Check again": the same Models-list call, with the saved key. The choices stay the owner's: each one still listed is checked
   * again (its web search tool, free token counting), and a warning shows for one that is retiring or has gone.
   */
  const checkAgain = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshProblem(null);
    try {
      const saved = await readSavedKey();
      if (saved === null) {
        setKey({ state: 'none' });
        return;
      }
      const answer = await listModels(saved);
      if (!answer.ok) return setRefreshProblem(SAVED_KEY_WORDS[answer.problem]);
      const next: ModelList = { checkedAt: Date.now(), models: parseModels(answer.value) };
      await saveList(next);
      setList(next);
      for (const { role: r } of ROLES) {
        const current = choices[r];
        const m = current === null ? undefined : findListed(next.models, current);
        if (m === undefined || m.lifecycle === 'retired') continue;
        const probe = await probeWebSearchTool(saved, m);
        if (probe.ok) await saveChoice(r, toChoice(m, probe.tool, next.checkedAt));
      }
      notify({ text: 'The model list is up to date.' });
    } catch {
      setRefreshProblem('Couldn’t read your saved key. Try again.');
    } finally {
      setRefreshing(false);
    }
  };

  /** A new model for a role: its web search tool is probed (free token counting), then it is saved. */
  const pick = async (r: ModelRole, m: ListedModel, said: string): Promise<void> => {
    setBusyRole(r);
    try {
      const saved = await readSavedKey();
      if (saved === null) {
        setKey({ state: 'none' });
        return;
      }
      const probe = await probeWebSearchTool(saved, m);
      if (!probe.ok) return notify({ text: SAVED_KEY_WORDS[probe.problem] });
      if (await saveChoice(r, toChoice(m, probe.tool, Date.now()))) notify({ text: said });
    } catch {
      notify({ text: 'Couldn’t change the model. Try again.' });
    } finally {
      setBusyRole(null);
    }
  };

  const changeWebSearch = (on: boolean) => {
    setWebSearch(on);
    data.setSetting(CLAUDE_SETTINGS.webSearch, on).catch(() => {
      setWebSearch(!on);
      notify({ text: 'Couldn’t change it. Try again.' });
    });
  };

  const saveUsd = async (k: string, v: number | null, done: (v: number | null) => void, said: string): Promise<void> => {
    try {
      await data.setSetting(k, v);
      done(v);
      notify({ text: said });
    } catch {
      notify({ text: 'Couldn’t save it. Try again.' });
    }
  };

  if (key.state === 'loading') return <section className={styles.loading} aria-busy="true" aria-label="Claude" />;

  const saved = key.state === 'saved';
  const entry = !saved || editing;
  const month = MONTH.format(now);
  const reached = spend !== null && cap !== null && nano(spend.usd) >= nano(cap);

  return (
    <SettingsSection
      id="claude"
      title="Claude"
      intro="Ask Claude about what you read, in any note. Claude uses your own key from Anthropic, and Anthropic bills you for what you ask. Nothing is sent until you ask Claude something."
    >
      <SettingsGroup
        id="claude-key"
        title="Your Claude key"
        description={
          <>
            Make a key in the <ConsoleLink href={CONSOLE_KEYS}>Anthropic Console</ConsoleLink>, under API keys, and paste it here. It stays on this
            computer, in a private place that web pages can’t read. It is never backed up, exported or synced.
          </>
        }
      >
        {saved && !editing && (
          <SettingsRow
            icon={<Icon name="key" size={20} />}
            label={`Key saved ····${key.ending}`}
            value="Only this computer has it. Delete it if you stop using Claude, or if someone else may have seen it."
            actions={
              <>
                <TextButton label="Change key" onClick={() => setEditing(true)} />
                <TextButton label="Delete key" onClick={() => void removeKey()} />
              </>
            }
          />
        )}
        {entry && (
          <KeyEntry
            draft={draft}
            check={check}
            replacing={saved}
            onDraft={(v) => {
              setDraft(v);
              if (check.phase === 'failed') setCheck({ phase: 'idle' });
            }}
            onCheck={() => void checkAndSave()}
            onCancel={() => {
              setEditing(false);
              setDraft('');
              setCheck({ phase: 'idle' });
            }}
          />
        )}
      </SettingsGroup>

      {!saved && (
        <SettingsNote icon={<Icon name="info" size={20} />}>
          An everyday question costs well under 1 cent. Think harder costs a few cents. Once your key is saved, you can set a monthly limit here.
        </SettingsNote>
      )}

      {saved && (
        <>
          <SettingsGroup id="claude-models" title="Models" description="Claude answers with your everyday model. Think harder asks the same question again with a stronger model, which costs more.">
            {ROLES.map(({ role: r, label, labelId, picked }) => {
              const choice = choices[r];
              const warning = choice !== null && list !== null ? retirementOf(list, choice) : null;
              return (
                <SettingsRow
                  key={r}
                  label={label}
                  labelId={labelId}
                  value={choice === null ? 'No model chosen yet. Choose one.' : modelFacts(choice, r)}
                  problem={warning === null || choice === null ? undefined : retirementWords(warning, choice.displayName, now)}
                  actions={<ModelPicker role={r} label={label} choice={choice} list={list} busy={busyRole === r} onPick={(m) => void pick(r, m, picked(m.displayName))} />}
                />
              );
            })}
            <SettingsRow
              label="Model list"
              value={list === null ? 'Not checked on this computer yet. Check it to choose models.' : checkedWords(list.checkedAt, now)}
              problem={refreshProblem ?? undefined}
              actions={<TextButton label={refreshing ? 'Checking…' : list === null ? 'Check models' : 'Check again'} disabled={refreshing} onClick={() => void checkAgain()} />}
            />
          </SettingsGroup>

          <SettingsGroup id="claude-web" title="Web search">
            <SettingsRow
              label="Let Claude search the web"
              labelId="claude-web-switch"
              value="For a question that needs outside knowledge, such as a definition or newer work, Claude may run one web search. Each search costs about 1 cent. The answer links to the pages it used."
              problem={
                webSearch === true && choices.default !== null && choices.default.webSearchTool === null
                  ? `${choices.default.displayName} can’t search the web, so everyday questions don’t search.`
                  : undefined
              }
              actions={<Switch checked={webSearch === true} disabled={webSearch === null} aria-labelledby="claude-web-switch" onChange={changeWebSearch} />}
            />
          </SettingsGroup>

          <SettingsGroup id="claude-spend" title="Spending" description="Anthropic bills your account for each question. Claude checks these limits on this computer before it asks.">
            <SettingsRow
              label="This month"
              value={<SpendLine spend={spend} cap={cap} month={month} reached={reached} />}
              problem={reached ? capReachedWords(cap ?? 0, now) : undefined}
            />
            <MoneyRow
              key={`cap-${cap ?? 'none'}`}
              id="claude-cap"
              label="Monthly limit"
              help="When this month’s spend reaches it, Claude stops answering until next month. Leave it empty for no limit."
              value={cap}
              allowEmpty
              placeholder="No limit"
              onCommit={(v) => saveUsd(CLAUDE_SETTINGS.monthlyCapUsd, v, setCap, v === null ? 'No monthly limit.' : `Monthly limit set to ${money(v)}.`)}
            />
            <MoneyRow
              key={`ask-${confirmOver}`}
              id="claude-ask"
              label="Ask before a costly question"
              help="When a question would cost more than this, Claude shows the cost and asks you first."
              value={confirmOver}
              allowEmpty={false}
              onCommit={(v) => saveUsd(CLAUDE_SETTINGS.confirmOverUsd, v, (x) => setConfirmOver(x ?? DEFAULT_CONFIRM_OVER_USD), `Claude now asks first when a question costs more than ${money(v ?? DEFAULT_CONFIRM_OVER_USD)}.`)}
            />
          </SettingsGroup>

          <SettingsNote icon={<Icon name="info" size={20} />}>
            <span>
              Set a monthly spend limit in the <ConsoleLink href={CONSOLE_LIMITS}>Anthropic Console</ConsoleLink> too. It stops the spending at Anthropic,
              even if this computer gets a sum wrong.
            </span>
          </SettingsNote>
        </>
      )}
    </SettingsSection>
  );
}

function capReachedWords(cap: number, now: number): string {
  if (cap === 0) return 'Your limit is $0, so Claude won’t answer. Raise the limit to ask Claude.';
  const next = new Date(now);
  next.setMonth(next.getMonth() + 1, 1);
  return `You’ve reached this month’s limit. Claude won’t answer until 1 ${MONTH.format(next)}, or until you raise the limit.`;
}

/** A link to the Anthropic Console, opened in a new tab by the owner's click. */
function ConsoleLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** The key field, its button, and what is happening: the hint, the check under way, or why it didn't work. */
function KeyEntry({
  draft,
  check,
  replacing,
  onDraft,
  onCheck,
  onCancel,
}: {
  draft: string;
  check: Check;
  replacing: boolean;
  onDraft(this: void, v: string): void;
  onCheck(this: void): void;
  onCancel(this: void): void;
}) {
  const checking = check.phase === 'checking';
  return (
    <div className={styles.entry}>
      <div className={styles.entryLine}>
        <TextField
          className={styles.keyField}
          type="password"
          label={replacing ? 'New Claude key' : 'Claude key'}
          placeholder={replacing ? 'Paste your new key here' : 'Paste your key here'}
          value={draft}
          invalid={check.phase === 'failed'}
          readOnly={checking}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          aria-describedby="claude-key-status"
          onChange={onDraft}
          onEnter={onCheck}
        />
        <TextButton variant="tonal" label={checking ? 'Checking…' : 'Check and save'} disabled={checking || draft.trim() === ''} onClick={onCheck} />
        {replacing && <TextButton label="Cancel" disabled={checking} onClick={onCancel} />}
      </div>
      <div id="claude-key-status" className={styles.status} role="status">
        {checking && (
          <>
            <span className={styles.hint}>Checking your key with Anthropic…</span>
            <span className={styles.track} aria-hidden="true">
              <span className={styles.moving} />
            </span>
          </>
        )}
        {check.phase === 'failed' && (
          <span className={styles.error}>
            <Icon name="error" size={20} />
            <span>{check.message}</span>
          </span>
        )}
        {check.phase === 'idle' && draft.trim() !== '' && (
          <span className={styles.hint}>Press Check and save. Your key is sent to Anthropic once, to check it, and then kept on this computer.</span>
        )}
      </div>
    </div>
  );
}

/** The button that shows a role's model and opens Anthropic's list, grouped by line, newest first. */
function ModelPicker({
  role,
  label,
  choice,
  list,
  busy,
  onPick,
}: {
  role: ModelRole;
  label: string;
  choice: ModelChoice | null;
  list: ModelList | null;
  busy: boolean;
  onPick(this: void, m: ListedModel): void;
}) {
  const items: MenuItemDef[] = [];
  (list === null ? [] : pickerGroups(list.models)).forEach((group, g) => {
    if (g > 0) items.push({ kind: 'separator' });
    items.push({ kind: 'heading', id: `claude-${role}-line-${g}`, label: group.label });
    group.models.forEach((m, i) => {
      const cost = priceFor(m).basis === 'unknown-line' ? 'price not known' : aboutCost(typicalQuestionUsd(toChoice(m, null, 0), role));
      items.push({ kind: 'item', id: `claude-${role}-${g}-${i}`, label: `${m.displayName} · ${cost}`, selected: choice !== null && m.id === choice.id, onSelect: () => onPick(m) });
    });
  });
  const name = busy ? 'Checking…' : (choice?.displayName ?? 'Choose a model');
  return (
    <DropdownMenu
      align="end"
      items={items}
      trigger={
        <button type="button" className={styles.picker} disabled={busy || items.length === 0} aria-label={`${label}: ${name}. Choose a model`}>
          <span className={styles.pickerText}>{name}</span>
          <Icon name="arrow_drop_down" size={20} />
        </button>
      }
    />
  );
}

/** This month's spend, and against the limit a thin meter (Drive's storage meter), in the error colour once it is reached. */
function SpendLine({ spend, cap, month, reached }: { spend: SpendRecord | null; cap: number | null; month: string; reached: boolean }) {
  if (spend === null) return <>…</>;
  const words =
    cap === null
      ? spend.usd === 0
        ? `Nothing spent yet in ${month}. No monthly limit.`
        : `${money(spend.usd)} spent in ${month}. No monthly limit.`
      : `${money(spend.usd)} of your ${money(cap)} limit, in ${month}.`;
  const share = cap === null || cap === 0 ? (reached ? 100 : 0) : Math.min(100, (spend.usd / cap) * 100);
  return (
    <>
      <span className={styles.spendWords}>{words}</span>
      {cap !== null && (
        <span
          className={reached ? `${styles.meter} ${styles.meterFull}` : styles.meter}
          role="meter"
          aria-label="This month’s spend"
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={Math.min(spend.usd, cap)}
          aria-valuetext={words}
        >
          <span className={styles.meterFill} style={{ inlineSize: `${share}%` }} />
        </span>
      )}
    </>
  );
}

/** A row with a dollar amount the owner can change. It is saved on Enter, or when the field loses the focus. */
function MoneyRow({
  id,
  label,
  help,
  value,
  allowEmpty,
  placeholder,
  onCommit,
}: {
  id: string;
  label: string;
  help: string;
  value: number | null;
  allowEmpty: boolean;
  placeholder?: string;
  onCommit(this: void, v: number | null): Promise<void>;
}) {
  const [text, setText] = useState(value === null ? '' : value.toFixed(2));
  const [problem, setProblem] = useState<string | null>(null);
  const commit = () => {
    const v = parseUsd(text);
    if (v === 'bad') return setProblem('Type an amount in dollars, such as 5 or 2.50.');
    if (v === null && !allowEmpty) return setProblem('Type an amount in dollars, such as 0.25.');
    setProblem(null);
    if (v === value) return setText(v === null ? '' : v.toFixed(2));
    void onCommit(v);
  };
  return (
    <SettingsRow
      label={label}
      labelId={`${id}-label`}
      value={help}
      problem={problem ?? undefined}
      actions={
        <span className={styles.money}>
          <span className={styles.dollar} aria-hidden="true">
            $
          </span>
          <TextField
            className={styles.moneyField}
            label={`${label}, in dollars`}
            value={text}
            placeholder={placeholder}
            inputMode="decimal"
            invalid={problem !== null}
            onChange={(v) => {
              setText(v);
              if (problem !== null) setProblem(null);
            }}
            onEnter={commit}
            onBlur={commit}
          />
        </span>
      }
    />
  );
}
