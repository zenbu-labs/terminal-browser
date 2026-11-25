export const HINT_ALPHABET = "sadfjklewcmpgh";

export function hintLabels(count: number, alphabet: string): string[] {
  if (count <= 0) return [];
  const base = alphabet.length;
  let length = 1;
  while (base ** length < count) length++;
  const labels: string[] = [];
  for (let index = 0; index < count; index++) {
    let label = "";
    let rest = index;
    for (let digit = 0; digit < length; digit++) {
      label = alphabet[rest % base] + label;
      rest = Math.floor(rest / base);
    }
    labels.push(label);
  }
  return labels;
}
