/** Every Material Symbol the interface uses. Add a name here before using it, so the glyph test covers it. */
export const ICON_NAMES = [
  // Phase 1
  'open_in_new',
  'download',
  'link',
  'print',
  'library_add',
  'library_add_check',
  'rotate_right',
  'rotate_left',
  'zoom_in',
  'zoom_out',
  'remove',
  'add',
  'arrow_drop_down',
  'auto_stories',
  'slideshow',
  'dark_mode',
  'photo_library',
  'toc',
  'find_in_page',
  'pageview',
  'keyboard',
  'info',
  'arrow_back',
  'close',
  'keyboard_arrow_up',
  'keyboard_arrow_down',
  'left_panel_close',
  'left_panel_open',
  'lock',
  'error',
  'check',
  'undo',
  'menu_book',
  // Phase 1: the viewer chrome (Task 23): View menu fit modes and the scan hint
  'fit_page_width',
  'fit_page',
  'document_scanner',
  // Phase 2: the right-click mark-up menu (S6, S13)
  'ink_highlighter',
  'format_underlined',
  'format_bold',
  'format_strikethrough',
  'add_comment', // also the pill's "Comment" text button, as in Drive's signed-in viewer (research 02 section 4.10)
  'search',
  'content_copy',
  'redo',
  // Phase 2: comment cards, the notes panel and figures (S5, S14, S15, S16)
  'comment',
  'more_vert',
  'edit',
  'delete',
  'send',
  'account_circle',
  'my_location', // "Show where it was" on a Moved card (D7)
  'location_off', // "Couldn't place"
  'image', // figure cards and the rail's Figures tab
  'select', // the area tool: a dashed rectangle
  'keep', // a pin (Material Symbols' push pin)
  'person', // the owner's avatar on comment cards (S5)
  // TB1 chrome polish: Go to page (not 'pageview', which looked like Find's icon beside it)
  'move_down',
  // Phase 3: the library shell, list and grid (S7): the nav, "+ New", the view toggle, sorting and the row actions
  'home',
  'library_books',
  'schedule',
  'star',
  'settings',
  'upload_file',
  'file_open',
  'add_link',
  'menu',
  'grid_view',
  'sort',
  'arrow_upward',
  'arrow_downward',
  'restore_from_trash',
  'search_off',
] as const;

export type IconName = (typeof ICON_NAMES)[number];
