// Settings → Claude (plan §4 slice G): reading Anthropic's live model list, choosing the models, and finding which web search
// tool each choice accepts.
//
// Model ids are data from the Models API, never code (CLAUDE.md, contracts A1 and D1). This file never parses an id or writes one:
// a model's line ("haiku", "opus") and its version come from the API's `line` and `display_name`. An id is only ever matched
// against the ids of the same list, to find the owner's stored choice in it again.
import type { ModelChoice, ModelRole } from '@sop/core';
import { type ApiProblem, countTokensAccepts } from './key-check';

/** The synced settings rows of contract §6. */
export const CLAUDE_SETTINGS = {
  modelDefault: 'claude.model.default',
  modelThinkHarder: 'claude.model.thinkHarder',
  webSearch: 'claude.webSearch',
  monthlyCapUsd: 'claude.monthlyCapUsd',
  confirmOverUsd: 'claude.confirmOverUsd',
} as const;

/** The setting each role's choice is kept in. */
export const CHOICE_SETTING: Readonly<Record<ModelRole, string>> = {
  'default': CLAUDE_SETTINGS.modelDefault,
  'think-harder': CLAUDE_SETTINGS.modelThinkHarder,
};

/** Contract §6 defaults. */
export const DEFAULT_WEB_SEARCH = true;
export const DEFAULT_CONFIRM_OVER_USD = 0.25;

/**
 * The web search tool types, newest useful first (plan §2): dynamic filtering, which uses fewer tokens, then the basic one.
 * The third version only adds response-inclusion control for agent workflows, which the viewer does not need.
 */
export const WEB_SEARCH_TOOL_TYPES: readonly string[] = ['web_search_20260209', 'web_search_20250305'];

/** The lines each role prefers, in order (owner: Haiku for everyday questions, Opus for Think harder). */
const PREFERRED_LINES: Readonly<Record<ModelRole, readonly string[]>> = {
  'default': ['haiku', 'sonnet'],
  'think-harder': ['opus', 'sonnet'],
};

/** How the pickers order the lines: cheapest first. Lines Anthropic adds later come after, by name; models with no line last. */
const LINE_ORDER: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'];

/** One model of the live list, as Settings uses it. */
export interface ListedModel {
  id: string;
  displayName: string;
  line: string | null;
  /** Release time in ms; 0 when Anthropic gives none. */
  createdAt: number;
  lifecycle: 'active' | 'deprecated' | 'retired';
  /** When Anthropic plans to retire it, in ms; null when no date is set. */
  retiresAt: number | null;
  imageInput: boolean;
  /** `capabilities.server_tools.web_search`: true when the model takes at least one version of the tool. */
  webSearch: boolean;
  maxInputTokens: number | null;
}

/** The list as last checked, kept on this computer so Settings can show the pickers and warnings without asking Anthropic. */
export interface ModelList {
  checkedAt: number;
  models: ListedModel[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const supported = (v: unknown): boolean => isRec(v) && v.supported === true;
const time = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** The models of a Models API answer that Settings can use. A row missing its id or name is left out. */
export function parseModels(data: readonly unknown[]): ListedModel[] {
  const out: ListedModel[] = [];
  for (const m of data) {
    if (!isRec(m) || typeof m.id !== 'string' || m.id === '' || typeof m.display_name !== 'string') continue;
    const caps = isRec(m.capabilities) ? m.capabilities : {};
    const tools = isRec(caps.server_tools) ? caps.server_tools : {};
    const lifecycle = m.lifecycle === 'deprecated' || m.lifecycle === 'retired' ? m.lifecycle : 'active';
    out.push({
      id: m.id,
      displayName: m.display_name,
      line: typeof m.line === 'string' && m.line !== '' ? m.line.toLowerCase() : null,
      createdAt: time(m.created_at) ?? 0,
      lifecycle,
      retiresAt: time(m.retires_at),
      imageInput: supported(caps.image_input),
      webSearch: supported(tools.web_search),
      maxInputTokens: typeof m.max_input_tokens === 'number' && m.max_input_tokens > 0 ? m.max_input_tokens : null,
    });
  }
  return out;
}

const newestFirst = (a: ListedModel, b: ListedModel) => b.createdAt - a.createdAt || a.displayName.localeCompare(b.displayName);

/** Models a new choice may use: active ones. A deprecated model is closed to new users (Models API docs). */
export const choosable = (models: readonly ListedModel[]): ListedModel[] => models.filter((m) => m.lifecycle === 'active');

/** The model setup picks for a role: the newest active one of the first line the role prefers that has one; else the newest active. */
export function preselect(models: readonly ListedModel[], role: ModelRole): ListedModel | null {
  const open = choosable(models).sort(newestFirst);
  for (const line of PREFERRED_LINES[role]) {
    const found = open.find((m) => m.line === line);
    if (found !== undefined) return found;
  }
  return open[0] ?? null;
}

/** "haiku" → "Haiku"; no line → "Other models". */
export function lineLabel(line: string | null): string {
  if (line === null) return 'Other models';
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The pickers' groups: active models by line, cheapest line first, newest first inside each. */
export function pickerGroups(models: readonly ListedModel[]): { line: string | null; label: string; models: ListedModel[] }[] {
  const byLine = new Map<string | null, ListedModel[]>();
  for (const m of choosable(models)) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
  const rank = (line: string | null) => (line === null ? Number.MAX_SAFE_INTEGER : LINE_ORDER.indexOf(line) === -1 ? LINE_ORDER.length : LINE_ORDER.indexOf(line));
  return [...byLine.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || (a ?? '').localeCompare(b ?? ''))
    .map(([line, list]) => ({ line, label: lineLabel(line), models: list.sort(newestFirst) }));
}

/** The owner's stored choice, found again in the list (by its id, which is data from the same API). */
export function findListed(models: readonly ListedModel[], choice: Pick<ModelChoice, 'id'>): ListedModel | undefined {
  return models.find((m) => m.id === choice.id);
}

/** What Settings warns about for a chosen model: Anthropic is retiring it (with the date when one is set), or it has gone. */
export type Retirement = { kind: 'retiring'; at: number | null } | { kind: 'gone' };

export function retirementOf(list: ModelList, choice: ModelChoice): Retirement | null {
  const m = findListed(list.models, choice);
  if (m === undefined || m.lifecycle === 'retired') return { kind: 'gone' };
  if (m.lifecycle === 'deprecated' || m.retiresAt !== null) return { kind: 'retiring', at: m.retiresAt };
  return null;
}

/**
 * Which web search tool type this model accepts, newest useful first, found with free token counting (plan §2 and A1). Answers
 * the type, null when it takes none (or its server tools list says it has no web search), or the problem that stopped the probe.
 */
export async function probeWebSearchTool(key: string, model: ListedModel): Promise<{ ok: true; tool: string | null } | { ok: false; problem: ApiProblem }> {
  if (!model.webSearch) return { ok: true, tool: null };
  for (const type of WEB_SEARCH_TOOL_TYPES) {
    const answer = await countTokensAccepts(key, {
      model: model.id,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ type, name: 'web_search', max_uses: 1 }],
    });
    if (!answer.ok) return answer;
    if (answer.value) return { ok: true, tool: type };
  }
  return { ok: true, tool: null };
}

/**
 * A listed model as the setting's value (contract A1). `serverFallback` is left unset: the Models API (docs checked 6 Nov 2026)
 * lists no fallback models for a model, so Think harder runs without the server fallback.
 */
export function toChoice(m: ListedModel, webSearchTool: string | null, now: number): ModelChoice {
  return { id: m.id, displayName: m.displayName, line: m.line, imageInput: m.imageInput, webSearchTool, maxInputTokens: m.maxInputTokens, checkedAt: now };
}

/** A stored setting read back as a ModelChoice, or null when it is not one (never set, or damaged). */
export function readChoice(v: unknown): ModelChoice | null {
  if (!isRec(v) || typeof v.id !== 'string' || v.id === '' || typeof v.displayName !== 'string') return null;
  return {
    id: v.id,
    displayName: v.displayName,
    line: typeof v.line === 'string' ? v.line : null,
    imageInput: v.imageInput === true,
    webSearchTool: typeof v.webSearchTool === 'string' ? v.webSearchTool : null,
    maxInputTokens: typeof v.maxInputTokens === 'number' ? v.maxInputTokens : null,
    checkedAt: typeof v.checkedAt === 'number' ? v.checkedAt : 0,
    ...(v.serverFallback === true ? { serverFallback: true } : {}),
  };
}

// ---- The list as last checked, on this computer ----

/**
 * Kept in chrome.storage.local, never synced or backed up: it is Anthropic's public list (names, dates, capabilities), so
 * Settings can draw the pickers and the retirement warning on a later visit without a call. It holds nothing about the key.
 */
const LIST_KEY = 'claude.modelList';

function readListedModel(v: unknown): ListedModel | null {
  if (!isRec(v) || typeof v.id !== 'string' || typeof v.displayName !== 'string') return null;
  return {
    id: v.id,
    displayName: v.displayName,
    line: typeof v.line === 'string' ? v.line : null,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    lifecycle: v.lifecycle === 'deprecated' || v.lifecycle === 'retired' ? v.lifecycle : 'active',
    retiresAt: typeof v.retiresAt === 'number' ? v.retiresAt : null,
    imageInput: v.imageInput === true,
    webSearch: v.webSearch === true,
    maxInputTokens: typeof v.maxInputTokens === 'number' ? v.maxInputTokens : null,
  };
}

export async function readSavedList(): Promise<ModelList | null> {
  try {
    const raw = (await chrome.storage.local.get(LIST_KEY))[LIST_KEY];
    if (!isRec(raw) || typeof raw.checkedAt !== 'number' || !Array.isArray(raw.models)) return null;
    const models = (raw.models as unknown[]).map(readListedModel).filter((m): m is ListedModel => m !== null);
    return { checkedAt: raw.checkedAt, models };
  } catch {
    return null;
  }
}

export async function saveList(list: ModelList): Promise<void> {
  try {
    await chrome.storage.local.set({ [LIST_KEY]: list });
  } catch {
    // the pickers then need "Check again" on the next visit; nothing is lost
  }
}
