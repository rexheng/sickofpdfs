// Which viewer this page shows, chosen once when it opens: the phone app's (a 56 px app bar, a page chip, touch selection with
// an action bar, the notes as a bottom sheet) on a phone, the extension's (Drive's header and toolbar pill, the right-click
// menu, the notes panel) on a computer. A window made narrow later keeps the viewer it opened with.

/** A phone: a narrow screen, or a touch screen no wider than a small tablet. */
export const PHONE_LAYOUT: boolean = (() => {
  try {
    return matchMedia('(max-width: 720px)').matches || matchMedia('(pointer: coarse) and (max-width: 900px)').matches;
  } catch {
    return false;
  }
})();
