/** Quotes one word for a POSIX shell (the device's `sh`). */
export function shQuote(word: string): string {
  if (word === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Joins words into one POSIX shell command line. */
export function shJoin(words: readonly string[]): string {
  return words.map(shQuote).join(" ");
}
