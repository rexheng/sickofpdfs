// The web's version of apps/extension/src/viewer/claude/ui/feature.tsx (swapped in by vite.config.ts). The Claude items stay
// where Chrome has them (the mark-up menu and Tools; the ⋮ menu on a phone), greyed out, with one plain line saying where to
// ask instead. Claude's replies and its comments from claude.ai are drawn as in Chrome.
import type { MenuItemDef } from '@sop/ui';
import type { ViewerFeature } from '@ext/viewer/annotations/wire';
import type { CommandBehaviour, ViewerCommandId } from '@ext/viewer/commands';
import { PHONE_LAYOUT } from './layout';

export { claudeReplyRenderer } from '@ext/viewer/claude/ui/feature';

/** The one line the web says about Claude. */
export const ASK_CLAUDE_ELSEWHERE = 'Ask Claude from the extension or from claude.ai.';

const elsewhere: CommandBehaviour = { run: () => {}, enabled: () => false, disabledReason: () => ASK_CLAUDE_ELSEWHERE };

/** On a phone the selection bar has no room for a row that does nothing: Claude is only in the ⋮ menu there. */
function commands(): Partial<Record<ViewerCommandId, CommandBehaviour>> {
  return PHONE_LAYOUT ? { 'claude.wholeDocument': elsewhere } : { 'claude.ask': elsewhere, 'claude.wholeDocument': elsewhere };
}

/** The figure menu has no Claude rows on the web. */
export function claudeFigureItems(): MenuItemDef[] {
  return [];
}

/** The note boxes do not offer @Claude on the web. */
export function claudePlaceholders(): { notePlaceholder?: string; replyPlaceholder?: string } {
  return {};
}

export const claudeUiFeature: ViewerFeature = { id: 'claude-ui', commands };
