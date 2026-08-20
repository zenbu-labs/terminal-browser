export function joinTargetWords(args: string[]): string[] {
  const words = args.filter((arg) => !arg.startsWith("-"));
  if (words.length <= 1) return args;
  const target = words.join(" ");
  let inserted = false;
  return args.flatMap((arg) => {
    if (arg.startsWith("-")) return [arg];
    if (inserted) return [];
    inserted = true;
    return [target];
  });
}
