export const MASK = "•";

const encoder = new TextEncoder();

function charsBefore(text: string, byteOffset: number): number {
  let bytes = 0;
  let chars = 0;
  for (const char of text) {
    if (bytes >= byteOffset) break;
    bytes += encoder.encode(char).length;
    chars++;
  }
  return chars;
}

// A password field shows one mask per character. After an edit the field reports
// its new text (old masks plus whatever was typed or pasted) and the caret as a
// byte offset, which is enough to rebuild the real value.
export function applyMaskedEdit(real: string, shown: string, cursorByte: number): string {
  const realChars = [...real];
  const shownChars = [...shown];
  const caret = charsBefore(shown, cursorByte);
  let insertedStart = caret;
  while (insertedStart > 0 && shownChars[insertedStart - 1] !== MASK) insertedStart--;
  const inserted = shownChars.slice(insertedStart, caret).join("");
  const kept = shownChars.length - (caret - insertedStart);
  const before = insertedStart;
  const after = Math.max(0, Math.min(kept - before, realChars.length - before));
  return realChars.slice(0, before).join("") + inserted + realChars.slice(realChars.length - after).join("");
}

export function masked(real: string): string {
  return MASK.repeat([...real].length);
}
