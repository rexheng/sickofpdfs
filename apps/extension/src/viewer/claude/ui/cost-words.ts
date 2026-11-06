// One way to say what Claude costs, everywhere the owner sees a cost (TB6 fix round, visual 6): the cost line under a reply,
// Think harder, the questions asked first, and the model list in Settings → Claude.
//
// - under 1 cent: "less than 1¢";
// - up to a dollar: "about 5¢" (whole cents);
// - above that: "$1.20".
// A cost that is not a number reads "an unknown amount".

export function costWords(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return 'an unknown amount';
  const cents = Math.round(usd * 100);
  if (usd * 100 < 1) return 'less than 1¢';
  if (cents < 100) return `about ${cents}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * An amount the owner set (a limit), as they typed it: "$0", "$5", "$0.25". It is exact, so it has no "about".
 */
export function amountWords(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return 'an unknown amount';
  const whole = Math.round(usd * 100) % 100 === 0;
  return whole ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}
