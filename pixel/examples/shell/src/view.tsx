import net from "node:net";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Box, createRoot, useRect } from "@zenbu-labs/pixel";
import type { NodeHandle } from "@zenbu-labs/pixel";

import { AiBar, ContextMenu } from "./view/aibar";
import type { AnswerScroll } from "./view/aibar";
import { CompletionDetails, CompletionPopup } from "./view/completion";
import { ModelMenu, ModelTrigger } from "./view/modelmenu";
import type { FromView, Rect, ToView, ViewState } from "./protocol";

const socket = net.connect(process.env.PXSH_SOCKET!);
const send = (message: FromView) => socket.write(JSON.stringify(message) + "\n");
const listeners = new Set<(message: ToView) => void>();
let buffer = "";
socket.setEncoding("utf8");
socket.on("data", (chunk: string) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const message = JSON.parse(buffer.slice(0, at)) as ToView;
    buffer = buffer.slice(at + 1);
    for (const listener of listeners) listener(message);
  }
});
socket.on("close", () => root.stop(0));
socket.on("error", () => root.stop(0));

const root = createRoot({
  name: "pxsh",
  onResize: ({ basePx }) => send({ type: "hello", basePx }),
});
root.setClearColor([0, 0, 0, 0]);
send({ type: "hello", basePx: root.info.basePx });

function Region(props: { name: string; regions: Map<string, Rect | null>; children: ReactNode; style?: object }) {
  const node = useRef<NodeHandle>(null);
  const rect = useRect(node);
  useEffect(() => {
    props.regions.set(props.name, rect);
    report(props.regions);
  }, [rect?.x, rect?.y, rect?.width, rect?.height]);
  useEffect(
    () => () => {
      props.regions.set(props.name, null);
      report(props.regions);
    },
    [],
  );
  return (
    <Box ref={node} style={{ position: "absolute", ...props.style }}>
      {props.children}
    </Box>
  );
}

let reported = "";
function report(regions: Map<string, Rect | null>) {
  const json = JSON.stringify(Object.fromEntries(regions));
  if (json === reported) return;
  reported = json;
  send({ type: "regions", regions: Object.fromEntries(regions) });
}

function App() {
  const [state, setState] = useState<ViewState | null>(null);
  const regions = useRef(new Map<string, Rect | null>()).current;
  const input = useRef<NodeHandle>(null);
  const text = useRef("");
  const answerScroll = useRef<AnswerScroll>(null);
  const keys = useRef<((key: string) => boolean) | null>(null);
  const menuKeys = useRef<string[]>([]);
  const [, setMenuKeysWaiting] = useState(0);

  useEffect(() => {
    const listener = (message: ToView) => {
      if (message.type === "state") setState(message.state);
      else if (message.type === "input") {
        input.current?.splice(0, Buffer.byteLength(text.current), message.text);
        text.current = message.text;
      } else if (message.type === "focusInput") {
        input.current?.focus();
        const end = Buffer.byteLength(text.current);
        input.current?.splice(end, end, "");
      } else if (message.type === "page") answerScroll.current?.page(message.direction);
      else if (message.type === "menuKey") {
        menuKeys.current.push(message.key);
        setMenuKeysWaiting((n) => n + 1);
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useLayoutEffect(() => root.queryLayout());

  const pickerOpen = state?.bar?.model?.open ?? false;
  useEffect(() => {
    if (!pickerOpen || !keys.current) {
      menuKeys.current = [];
      return;
    }
    const key = menuKeys.current.shift();
    if (key == null) return;
    keys.current(key);
    if (menuKeys.current.length) setMenuKeysWaiting((n) => n + 1);
  });

  if (!state) return null;
  const s = root.info.basePx / 13;
  const { bar, completion, menu, colors, menuColors } = state;
  return (
    <Box style={{ width: "100%", height: "100%" }}>
      {bar && (
        <Region name="bar" regions={regions} style={{ inset: bar.inset, flexDirection: "column" }}>
          <AiBar
            ref={input}
            colors={{ ...colors, panel: menuColors.panel }}
            scale={s}
            width={bar.width}
            maxHeight={bar.maxHeight}
            answerScroll={answerScroll}
            text={text.current}
            busy={bar.busy}
            status={bar.status}
            ready={bar.ready}
            answer={bar.answer}
            error={bar.error}
            notice={bar.notice}
            modelMenu={
              bar.model && (
                <ModelMenu
                  colors={{ ...colors, panel: menuColors.panel }}
                  scale={s}
                  frame={{ width: root.info.width, height: root.info.height }}
                  groups={bar.model.groups}
                  choice={bar.model.choice}
                  conversation={bar.model.conversation}
                  open={bar.model.open}
                  onOpenChange={(open) => send({ type: "picker", open })}
                  onChoice={(choice) => send({ type: "choice", choice })}
                  keys={keys}
                  onRect={(rect) => {
                    regions.set("picker", rect);
                    report(regions);
                  }}
                >
                  {(open) => <ModelTrigger label={bar.model!.label} open={open} colors={colors} scale={s} />}
                </ModelMenu>
              )
            }
            onText={(value) => {
              text.current = value;
              send({ type: "text", value });
            }}
            onSubmit={() => send({ type: "submit" })}
            onStop={() => send({ type: "stop" })}
            onClose={() => send({ type: "close" })}
            onFocusInput={() => send({ type: "focusBar" })}
          />
        </Region>
      )}
      {completion && (
        <Region name="completion" regions={regions} style={{ inset: { left: completion.left, top: completion.top } }}>
          <CompletionPopup
            rows={completion.rows}
            selected={completion.selected}
            top={completion.top_}
            visible={completion.visible}
            width={completion.width}
            empty={completion.empty}
            more={completion.more}
            colors={menuColors}
            scale={s}
            onPick={(row) => send({ type: "pick", row })}
            onWheel={(rows) => send({ type: "wheel", rows })}
          />
        </Region>
      )}
      {completion?.details && (
        <Region name="details" regions={regions} style={{ inset: completion.details.inset }}>
          <CompletionDetails item={completion.details.item} width={completion.details.width} colors={menuColors} scale={s} />
        </Region>
      )}
      {menu && (
        <Region name="menu" regions={regions} style={{ inset: { left: menu.x, top: menu.y } }}>
          <ContextMenu items={menu.items} colors={menuColors} scale={s} onPick={(index) => send({ type: "menu", index })} />
        </Region>
      )}
    </Box>
  );
}

root.render(<App />);
