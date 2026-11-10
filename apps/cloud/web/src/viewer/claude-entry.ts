// The web's version of apps/extension/src/viewer/claude/entry.ts (swapped in by vite.config.ts). @Claude reads with the owner's
// API key, which only the extension keeps (in its private store, never synced). So on the web nothing asks Claude, and nothing
// is ever sent to Anthropic from this page: the feature has no view and no commands. Claude's replies and comments that came
// through sync still show, as in Chrome (claude-feature.tsx).
import type { ViewerFeature } from '@ext/viewer/annotations/wire';

export const claudeEntryFeature: ViewerFeature = { id: 'claude-entry' };
