/** True in an Incognito window. There the extension only views PDFs: no marks, notes or saving, and no library. */
export function isIncognito(): boolean {
  return globalThis.chrome?.extension?.inIncognitoContext === true;
}
