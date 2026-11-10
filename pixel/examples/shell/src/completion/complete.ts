export const COMPLETION_WIDGETS = `
_pxsh_compadd() {
  local -A apre hpre dscrs oad mesg
  local -a isfile opts ignored expl group
  zparseopts -E -a opts P:=apre p:=hpre d:=dscrs X+:=expl O:=oad A:=oad D:=oad f=isfile \\
    i: S: s: I: x:=mesg r: R: W: F: M+: E: q e Q n U C \\
    J:=group V:=group a=ignored l=ignored k=ignored o=ignored 1=ignored 2=ignored
  if (( $#oad )); then
    builtin compadd "$@"
    return
  fi
  local -a hits shown
  (( $#dscrs == 1 )) && shown=("\${(@P)\${(v)dscrs}}")
  builtin compadd -A hits -D shown "$@"
  local ret=$?
  if (( ! $#hits )); then
    (( $#mesg )) && _pxsh_comp_messages+=("\${(v)mesg}")
    return ret
  fi
  local name=\${group[-1]} sorted=1
  [[ $name == -[JV]?* ]] && name=\${name:2}
  [[ $group[-2] == -V || $group[-1] == -V?* ]] && sorted=0
  local key="$name"$'\\x1f'"$curtag"$'\\x1f'"\${expl[-1]}"$'\\x1f'$sorted$'\\x1f'"$PREFIX"
  local index=$_pxsh_comp_groups[(ie)$key]
  (( index > $#_pxsh_comp_groups )) && _pxsh_comp_groups+=("$key")
  local call= field
  for field in IPREFIX PREFIX SUFFIX ISUFFIX; do call+=$field$'\\0'\${(P)field}$'\\0'; done
  opts+=("\${(@kv)apre}" "\${(@kv)hpre}" $isfile)
  call+=args$'\\0'\${(pj:\\1:)opts}
  _pxsh_comp_calls+=("$call")
  _pxsh_comp_words+=("\${hits[@]}")
  (( $#shown == $#hits )) || shown=("\${(@)hits/*/}")
  _pxsh_comp_shown+=("\${shown[@]}")
  _pxsh_comp_call+=("\${(@)hits/*/$#_pxsh_comp_calls}")
  _pxsh_comp_group+=("\${(@)hits/*/$index}")
  if [[ -n $isfile ]]; then
    local dir=\${\${(Qe)~\${:-$IPREFIX\${hpre[-p]}}}} word
    for word in "\${hits[@]}"; do
      [[ -d $dir\${(Q)word} ]] && _pxsh_comp_kind+=/ || _pxsh_comp_kind+=f
    done
  else
    _pxsh_comp_kind+=("\${(@)hits/*/}")
  fi
  _pxsh_stop_later_completers
}
_pxsh_stop_later_completers() {
  builtin compadd -U -n ''
}
_pxsh_history_lines() {
  (( $+history )) || return
  if (( PENDING || KEYS_QUEUED_COUNT )); then
    _pxsh_mark "H;skip"
    return
  fi
  local top=$(( $1 ? $1 : HISTCMD )) i
  local -a lines=()
  for (( i = top - 1; i > top - 1 - $2 && i > 0; i-- )); do lines+=("$history[$i]"); done
  lines=("\${(@)lines//\\%/%25}")
  lines=("\${(@)lines//$'\\a'/%07}")
  lines=("\${(@)lines//$'\\e'/%1B}")
  lines=("\${(@)lines//$'\\n'/%0A}")
  lines=("\${(@)lines//;/%3B}")
  lines=("\${(@)lines//$'\\x1e'/%1E}")
  _pxsh_mark "H;$(( top - 1 ));$(( HISTCMD - $#history ));\${(pj:\\x1e:)lines}"
}
_pxsh_history_keys() {
  local -a keys=(\${(k)history[(R)$1]})
  if (( $#keys <= 2 * $2 + 200 )); then
    reply=(\${\${(On)keys}[1,$2]})
    return
  fi
  reply=()
  local i
  for (( i = HISTCMD - 1; i > 0 && $#reply < $2; i-- )); do
    [[ $history[$i] == \${~1} ]] && reply+=($i)
  done
}
_pxsh_complete_list() {
  typeset -ga _pxsh_comp_calls=() _pxsh_comp_words=() _pxsh_comp_shown=() _pxsh_comp_call=() _pxsh_comp_group=() _pxsh_comp_kind=() _pxsh_comp_groups=() _pxsh_comp_messages=()
  typeset -g _pxsh_comp_buffer=$BUFFER _pxsh_comp_cursor=$CURSOR
  (( _pxsh_comp_gen++ ))
  local saved=$functions[compadd]
  local -a grouped
  zstyle -g grouped ':completion:*' list-grouped
  zstyle ':completion:*' list-grouped false
  functions[compadd]=$functions[_pxsh_compadd]
  compstate[insert]=\${compstate[insert]//tab /}
  {
    if (( $+functions[_ftb__main_complete] )); then
      _ftb__main_complete
    else
      _main_complete
    fi
  } always {
    if [[ -n $saved ]]; then functions[compadd]=$saved; else unfunction compadd; fi
    if (( $#grouped )); then zstyle ':completion:*' list-grouped $grouped; else zstyle -d ':completion:*' list-grouped; fi
  }
  compstate[insert]=
  compstate[list]=
  local -a reply
  local word=\${LBUFFER##* } line key current=$BUFFER
  local before=\${LBUFFER[1,$#LBUFFER-$#word]}
  typeset -ga _pxsh_comp_history=()
  _pxsh_history_keys "\${(b)LBUFFER}?*" 50
  for key in $reply; do
    line=$history[$key]
    [[ $line == "$current" ]] && continue
    current=$line
    (( $_pxsh_comp_history[(Ie)$line] )) || _pxsh_comp_history+=("$line")
    (( $#_pxsh_comp_history < _pxsh_comp_history_limit )) || break
  done
  local -a past=("\${_pxsh_comp_history[@]}") used=()
  _pxsh_history_keys "\${(b)before}?*" _pxsh_comp_used_limit
  for key in $reply; do
    line=\${history[$key]:$#before}
    used+=("\${line%%[[:space:]]*}")
  done
  local -a words=("\${(@)_pxsh_comp_words[1,_pxsh_comp_limit]}") shown=("\${(@)_pxsh_comp_shown[1,_pxsh_comp_limit]}") groups=("\${_pxsh_comp_groups[@]}") messages=("\${_pxsh_comp_messages[@]}")
  local name
  for name in words shown groups messages past used; do
    set -A $name "\${(@)\${(@P)name}//\\%/%25}"
    set -A $name "\${(@)\${(@P)name}//$'\\a'/%07}"
    set -A $name "\${(@)\${(@P)name}//$'\\e'/%1B}"
    set -A $name "\${(@)\${(@P)name}//$'\\n'/%0A}"
    set -A $name "\${(@)\${(@P)name}//;/%3B}"
    set -A $name "\${(@)\${(@P)name}//$'\\x1e'/%1E}"
    [[ $name == groups ]] || set -A $name "\${(@)\${(@P)name}//$'\\x1f'/%1F}"
  done
  _pxsh_mark "M;$_pxsh_comp_gen;$#_pxsh_comp_words;\${(pj:\\x1e:)groups};\${(pj:\\x1e:)messages};\${(pj:\\x1e:)words};\${(pj:\\x1e:)shown};\${(pj:\\x1e:)_pxsh_comp_group[1,_pxsh_comp_limit]};\${(pj:\\x1e:)_pxsh_comp_kind[1,_pxsh_comp_limit]};\${(pj:\\x1e:)past};\${(pj:\\x1e:)used}"
}
_pxsh_complete_apply() {
  local -A v=("\${(@0)_pxsh_comp_calls[$_pxsh_comp_call[_pxsh_comp_choice]]}")
  local -a args=("\${(@ps:\\1:)v[args]}")
  [[ -z $args[1] ]] && args=()
  IPREFIX=$v[IPREFIX] PREFIX=$v[PREFIX] SUFFIX=$v[SUFFIX] ISUFFIX=$v[ISUFFIX]
  builtin compadd "\${args[@]:--Q}" -Q -- "$_pxsh_comp_words[_pxsh_comp_choice]"
  compstate[list]=
  compstate[insert]='1 '
}
typeset -gi _pxsh_comp_gen=0 _pxsh_comp_limit=20000 _pxsh_comp_choice=0 _pxsh_comp_history_limit=5 _pxsh_comp_used_limit=500
zle -C _pxsh_complete_list complete-word _pxsh_complete_list
zle -C _pxsh_complete_apply complete-word _pxsh_complete_apply
`;

interface CompletionGroup {
  name: string;
  tag: string;
  explanation: string;
  sorted: boolean;
  prefix: string;
}

export interface CompletionItem {
  index: number;
  history: boolean;
  word: string;
  label: string;
  description: string;
  directory: boolean;
  group: number;
}

export interface CompletionList {
  generation: number;
  total: number;
  groups: CompletionGroup[];
  messages: string[];
  items: CompletionItem[];
  history: CompletionItem[];
  usage: Map<string, { count: number; newest: number }>;
}

function decode(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

const split = (field: string | undefined) => (field ? field.split("\x1e") : []);

function plainMessage(text: string): string {
  return text.replace(/%[FK]\{[^}]*\}|%[BbUuSsFfKk]/g, "").replace(/%%/g, "%");
}

export function parseCompletions(body: string): CompletionList {
  const [generation, total, groups, messages, words, shown, groupIndex, kinds, past, used] = body.split(";");
  const parsedGroups = split(groups).map((record): CompletionGroup => {
    const [name, tag, explanation, sorted, prefix] = record.split("\x1f").map(decode);
    return { name, tag, explanation, sorted: sorted === "1", prefix: prefix ?? "" };
  });
  const shownList = split(shown);
  const groupList = split(groupIndex);
  const fileKinds = split(kinds);
  const items = split(words).map((encoded, i): CompletionItem => {
    const word = decode(encoded);
    const display = decode(shownList[i] ?? "");
    const described = /^(.*?)\s+-- (.*)$/s.exec(display);
    const group = Number(groupList[i]) - 1;
    const directory = fileKinds[i] === "/";
    const label = described ? described[1] : display || word;
    return { index: i + 1, history: false, word, label: directory && !label.endsWith("/") ? `${label}/` : label, description: described?.[2].replace(/\s+/g, " ").trim() ?? "", directory, group };
  });
  const history = split(past).map((encoded, i) => historyItem(decode(encoded), i + 1));
  const usage = new Map<string, { count: number; newest: number }>();
  split(used).forEach((encoded, i) => {
    const word = decode(encoded);
    const seen = usage.get(word);
    if (seen) seen.count++;
    else usage.set(word, { count: 1, newest: i });
  });
  return {
    generation: Number(generation),
    total: Number(total),
    groups: parsedGroups,
    messages: split(messages).map(decode).map(plainMessage).filter(Boolean),
    items,
    history,
    usage,
  };
}

export function historyItem(line: string, index: number): CompletionItem {
  return { index, history: true, word: line, label: line.replace(/\n/g, " ⏎ "), description: "", directory: false, group: -1 };
}

export function completionRows(list: CompletionList, items: CompletionItem[] = list.items, typed = ""): CompletionItem[] {
  const sections = new Map<string, { sorted: boolean; items: CompletionItem[] }>();
  const seen = new Set<string>();
  for (const item of items) {
    const group = list.groups[item.group];
    const once = `${group?.name}\x1f${item.word}`;
    if (seen.has(once)) continue;
    seen.add(once);
    const tag = group?.tag || group?.name || "";
    let section = sections.get(tag);
    if (!section) {
      section = { sorted: group?.sorted ?? true, items: [] };
      sections.set(tag, section);
    }
    section.items.push(item);
  }
  const ordered = [...sections.values()].flatMap((section) =>
    section.sorted ? section.items.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)) : section.items,
  );
  const exact = (item: CompletionItem) => unquote(item.word) === (list.groups[item.group]?.prefix ?? "") + typed;
  const usage = (item: CompletionItem) => list.usage.get(item.word) ?? list.usage.get(`${item.word}/`);
  return ordered
    .map((item, order) => ({ item, order, exact: exact(item), usage: usage(item) }))
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        (b.usage?.count ?? 0) - (a.usage?.count ?? 0) ||
        (a.usage?.newest ?? Infinity) - (b.usage?.newest ?? Infinity) ||
        a.order - b.order,
    )
    .map(({ item }) => item);
}

export function historyRows(list: CompletionList, left: string): CompletionItem[] {
  return list.history.filter((item) => item.word.startsWith(left) && item.word !== left);
}

function unquote(word: string): string {
  return word.replace(/\\(.)|['"]/gs, (_, escaped: string | undefined) => escaped ?? "");
}

export function narrowCompletions(list: CompletionList, typed: string): CompletionItem[] {
  return list.items.filter((item) => {
    const want = ((list.groups[item.group]?.prefix ?? "") + typed).toLowerCase();
    return unquote(item.word).toLowerCase().startsWith(want);
  });
}

export function typedSince(before: { buffer: string; cursor: number }, after: { buffer: string; cursor: number }): string | null {
  const a = Array.from(before.buffer);
  const b = Array.from(after.buffer);
  const added = b.length - a.length;
  if (added < 0 || after.cursor !== before.cursor + added) return null;
  if (b.slice(0, before.cursor).join("") !== a.slice(0, before.cursor).join("")) return null;
  if (b.slice(after.cursor).join("") !== a.slice(before.cursor).join("")) return null;
  return b.slice(before.cursor, after.cursor).join("");
}

export function wordStart(buffer: string, cursor: number): number {
  const chars = Array.from(buffer);
  let start = Math.min(cursor, chars.length);
  while (start > 0) {
    const c = chars[start - 1];
    if (/[\s;|&<>()]/.test(c) && chars[start - 2] !== "\\") break;
    start--;
  }
  return start;
}

export function completionMove(chord: string, page: number): number | null {
  const moves: Record<string, number> = { up: -1, "ctrl+p": -1, down: 1, "ctrl+n": 1, pageup: -page, pagedown: page };
  return moves[chord] ?? null;
}

export function moveSelection(count: number, selected: number, delta: number): number {
  if (!count) return -1;
  const at = Math.max(0, selected);
  return Math.abs(delta) === 1 ? (at + delta + count) % count : Math.max(0, Math.min(count - 1, at + delta));
}

export function scrollTop(top: number, selected: number, visible: number, total: number): number {
  let next = top;
  if (selected < next) next = selected;
  else if (selected >= next + visible) next = selected - visible + 1;
  return Math.max(0, Math.min(next, total - visible));
}

export function popupPlacement(o: {
  caret: { row: number; col: number };
  cell: { width: number; height: number };
  pane: { width: number; height: number };
  width: number;
  rowHeight: number;
  chrome: number;
  rows: number;
  side?: "below" | "above";
}): { left: number; top: number; side: "below" | "above"; visible: number; height: number } {
  const below = (o.caret.row + 1) * o.cell.height;
  const roomBelow = o.pane.height - below;
  const roomAbove = o.caret.row * o.cell.height;
  const full = o.rows * o.rowHeight + o.chrome;
  const side = o.side ?? (full <= roomBelow ? "below" : full <= roomAbove ? "above" : roomBelow >= roomAbove ? "below" : "above");
  const room = side === "below" ? roomBelow : roomAbove;
  const visible = Math.max(1, Math.min(o.rows, Math.floor((room - o.chrome) / o.rowHeight)));
  const height = visible * o.rowHeight + o.chrome;
  const top = side === "below" ? below : Math.max(0, roomAbove - height);
  return { left: Math.max(0, Math.min(o.caret.col * o.cell.width, o.pane.width - o.width)), top, side, visible, height };
}

export class HistoryCache {
  private lines: { event: number; line: string }[] = [];
  private below = 0;
  private oldest = 0;

  static readonly LIMIT = 10_000;

  get size(): number {
    return this.lines.length;
  }

  next(): number | null {
    if (this.below && (this.below <= this.oldest || this.lines.length >= HistoryCache.LIMIT)) return null;
    return this.below;
  }

  addChunk(chunk: { newest: number; oldest: number; lines: string[] }): void {
    chunk.lines.forEach((line, i) => this.add(chunk.newest - i, line));
    this.oldest = chunk.oldest;
    this.below = Math.max(1, chunk.newest - chunk.lines.length + 1);
    if (!chunk.lines.length) this.below = chunk.oldest;
  }

  add(event: number, line: string): void {
    if (!line) return;
    let at = this.lines.findIndex((entry) => entry.event <= event);
    if (at < 0) at = this.lines.length;
    if (this.lines[at]?.event === event) this.lines[at] = { event, line };
    else this.lines.splice(at, 0, { event, line });
    if (this.lines.length > HistoryCache.LIMIT) this.lines.length = HistoryCache.LIMIT;
  }

  upArrow(left: string, line: string, limit = 5): string[] {
    const found: string[] = [];
    let current = line;
    for (const entry of this.lines) {
      if (!entry.line.startsWith(left) || entry.line === left || entry.line === current) continue;
      current = entry.line;
      if (!found.includes(entry.line)) found.push(entry.line);
      if (found.length >= limit) break;
    }
    return found;
  }
}
