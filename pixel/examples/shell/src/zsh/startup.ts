import fs from "node:fs";
import path from "node:path";

import { COMPLETION_WIDGETS } from "../completion/complete";

export const MARKER_CODE = "6973";
const COMMAND_KEY = `\x1b[${MARKER_CODE}~`;

export const GESTURE_KEYS: Record<string, string> = {
  "shift+left": "\x1b[1;2D",
  "shift+right": "\x1b[1;2C",
  "shift+home": "\x1b[1;2H",
  "shift+end": "\x1b[1;2F",
  "alt+shift+left": "\x1b[1;4D",
  "alt+shift+right": "\x1b[1;4C",
};

function zshQuote(text: string): string {
  return `$'${[...Buffer.from(text)].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("")}'`;
}

export function encodeCommand(line: string): string {
  return `${COMMAND_KEY}${line.length}:${line}`;
}

export function writeStartupFiles(dir: string, nonce: string): void {
  const gestures = Object.values(GESTURE_KEYS).map(zshQuote).join(" ");
  fs.writeFileSync(
    path.join(dir, ".zshenv"),
    `_pxsh_dir=$ZDOTDIR
ZDOTDIR=\${PXSH_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
_pxsh_user_dir=$ZDOTDIR
ZDOTDIR=$_pxsh_dir
if [[ -o interactive && -r $GHOSTTY_RESOURCES_DIR/shell-integration/zsh/ghostty-integration ]]; then
  autoload -Uz -- $GHOSTTY_RESOURCES_DIR/shell-integration/zsh/ghostty-integration
  ghostty-integration
  unfunction ghostty-integration
fi
`,
  );
  fs.writeFileSync(
    path.join(dir, ".zprofile"),
    `ZDOTDIR=$_pxsh_user_dir
[[ -r $ZDOTDIR/.zprofile ]] && source $ZDOTDIR/.zprofile
ZDOTDIR=$_pxsh_dir
`,
  );
  fs.writeFileSync(
    path.join(dir, ".zshrc"),
    `ZDOTDIR=$_pxsh_user_dir
[[ $HISTFILE == $_pxsh_dir/.zsh_history ]] && HISTFILE=$ZDOTDIR/.zsh_history
[[ -r $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
[[ -n $PXSH_KEEP_ZDOTDIR ]] || unset ZDOTDIR
unset PXSH_USER_ZDOTDIR PXSH_KEEP_ZDOTDIR _pxsh_dir _pxsh_user_dir
_pxsh_mark() { printf '\\e]${MARKER_CODE};${nonce};%s\\a' "$1" }
_pxsh_encode() {
  local text=\${1//\\%/%25}
  text=\${text//$'\\a'/%07}
  text=\${text//$'\\e'/%1B}
  text=\${text//$'\\n'/%0A}
  REPLY=\${text//;/%3B}
}
_pxsh_precmd() {
  local code=$? line bound=
  for line in \${(f)"$(for line in ${gestures}; do bindkey -M main -- $line; done)"}; do
    [[ $line == *' undefined-key' ]] && bound+=0 || bound+=1
  done
  _pxsh_encode "$PWD"
  local cwd=$REPLY newest=
  if (( $+history )); then
    _pxsh_encode "$history[$(( HISTCMD - 1 ))]"
    newest="$(( HISTCMD - 1 ));$REPLY"
  fi
  _pxsh_mark "D;$code;$cwd;$bound;$newest"
}
_pxsh_preexec() { _pxsh_mark C }
_pxsh_report() {
  local buffer post pre
  _pxsh_encode "$BUFFER"; buffer=$REPLY
  _pxsh_encode "$POSTDISPLAY"; post=$REPLY
  _pxsh_encode "$PREDISPLAY"; pre=$REPLY
  _pxsh_encode "\${(pj:\\n:)region_highlight}"
  _pxsh_mark "E;$KEYMAP;$CURSOR;$MARK;$REGION_ACTIVE;$buffer;$post;$pre;$REPLY;$UNDO_CHANGE_NO;$HISTNO"
}
_pxsh_finish() { _pxsh_mark F }
precmd_functions=(_pxsh_precmd \${precmd_functions:#_pxsh_precmd})
preexec_functions=(\${preexec_functions:#_pxsh_preexec} _pxsh_preexec)
autoload -Uz add-zle-hook-widget
add-zle-hook-widget line-init _pxsh_report
add-zle-hook-widget line-pre-redraw _pxsh_report
add-zle-hook-widget line-finish _pxsh_finish
${COMPLETION_WIDGETS}_pxsh_redo_all_then_undo_to() {
  repeat $(( 2 * UNDO_CHANGE_NO + 1 )); do zle .redo || break; done
  zle .undo $1
}
_pxsh_command() {
  local c count= line= text
  while read -k 1 c && [[ $c != : ]]; do count+=$c; done
  (( count > 0 )) && read -k $count line
  local -a part=("\${(@s: :)line}")
  local before=$BUFFER
  case $part[1] in
    cursor) CURSOR=$part[2]; REGION_ACTIVE=0 ;;
    select) MARK=$part[2]; CURSOR=$part[3]; REGION_ACTIVE=1 ;;
    insert)
      printf -v text '%b' "\${\${part[2]-}//\\%/\\\\x}"
      if (( REGION_ACTIVE )); then
        local from=$(( MARK < CURSOR ? MARK : CURSOR )) to=$(( MARK > CURSOR ? MARK : CURSOR ))
        BUFFER=\${BUFFER[1,$from]}$text\${BUFFER[$((to + 1)),-1]}
        CURSOR=$((from + \${#text}))
        REGION_ACTIVE=0
      else
        LBUFFER+=$text
      fi ;;
    extend)
      (( REGION_ACTIVE )) || { MARK=$CURSOR; REGION_ACTIVE=1 }
      case $part[2] in
        left) (( CURSOR > 0 )) && (( CURSOR-- )) ;;
        right) (( CURSOR < $#BUFFER )) && (( CURSOR++ )) ;;
        word-left) zle backward-word ;;
        word-right) zle forward-word ;;
        home) CURSOR=0 ;;
        end) CURSOR=$#BUFFER ;;
      esac ;;
    collapse)
      if (( REGION_ACTIVE )); then
        [[ $part[2] == left ]] && CURSOR=$(( MARK < CURSOR ? MARK : CURSOR ))
        [[ $part[2] == right ]] && CURSOR=$(( MARK > CURSOR ? MARK : CURSOR ))
      fi
      REGION_ACTIVE=0 ;;
    set)
      printf -v text '%b' "\${\${part[2]-}//\\%/\\\\x}"
      BUFFER=$text
      CURSOR=\${#BUFFER}
      REGION_ACTIVE=0 ;;
    undo)
      if [[ -n $part[2] ]]; then
        zle .undo $part[2]
      else
        zle undo
      fi ;;
    redo)
      if [[ -n $part[2] ]]; then
        _pxsh_redo_all_then_undo_to $part[2]
      else
        zle redo
      fi ;;
    complete) zle _pxsh_complete_list ;;
    accept)
      if [[ $part[2] == $_pxsh_comp_gen && $BUFFER == "$_pxsh_comp_buffer" && $CURSOR == $_pxsh_comp_cursor ]]; then
        _pxsh_comp_choice=$part[3]
        zle _pxsh_complete_apply
      fi ;;
    history-lines) _pxsh_history_lines $part[2] $part[3] ;;
    history)
      if [[ $part[2] == $_pxsh_comp_gen && $BUFFER == "$_pxsh_comp_buffer" && $CURSOR == $_pxsh_comp_cursor ]]; then
        BUFFER=$_pxsh_comp_history[$part[3]]
        CURSOR=$#BUFFER
      fi ;;
  esac
  if [[ $BUFFER != $before ]]; then
    unset POSTDISPLAY
    (( $+widgets[autosuggest-fetch] )) && zle autosuggest-fetch
  fi
}
zle -N _pxsh_command
for _pxsh_keymap in \${(f)"$(bindkey -l)"}; do
  [[ $_pxsh_keymap == .safe ]] || bindkey -M $_pxsh_keymap '\\e[${MARKER_CODE}~' _pxsh_command
done
unset _pxsh_keymap
`,
  );
}
