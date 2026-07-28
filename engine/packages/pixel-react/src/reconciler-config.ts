import Reconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants";

import { createNativeEngine, NativeEngine } from "./native";
import { Color, parseColor, serializeStyle, Style } from "./styles";
import { Surface, surfaceId } from "./surface";

export const APP_VIEW = 0;
export const DEVTOOLS_VIEW = 1;

export interface ClickEvent {
  x: number;
  y: number;
  offset?: number;
}

export interface ScrollEvent {
  offset: number;
  max: number;
}

export interface EventMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  super: boolean;
}

export interface WheelEvent {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  precise: boolean;
  mods: EventMods;
}

export interface PointerEvent {
  kind: "down" | "up" | "move";
  button: "left" | "middle" | "right" | "none";
  mods: {
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
    super: boolean;
  };
  x: number;
  y: number;
}

export interface DragEvent {
  phase: "start" | "move" | "end";
  x: number;
  y: number;
  mods: EventMods;
}

export interface MouseMoveEvent {
  x: number;
  y: number;
}

export interface SelectionPart {
  key: string;
  start: number;
  end: number;
}

export interface ContainerSelection {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parts: SelectionPart[];
}

export interface BoxProps {
  style?: Style;
  id?: string;
  onClick?: (event: ClickEvent) => void;
  onClickOutside?: (event: ClickEvent) => void;
  onScroll?: (event: ScrollEvent) => void;
  onWheel?: (event: WheelEvent) => void;
  onPointer?: (event: PointerEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onMouseMove?: (event: MouseMoveEvent) => void;
  onDrag?: (event: DragEvent) => void;
  onSelection?: (selection: ContainerSelection) => void;
  contentHeight?: number;
  surface?: Surface;
  children?: React.ReactNode;
}

export interface ShapeStroke {
  width: number;
  color: Color;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
}

export interface PathProps {
  style?: Style;
  id?: string;
  hidden?: boolean;
  d: string;
  stroke: ShapeStroke;
  viewBox?: number;
  onClick?: (event: ClickEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onDrag?: (event: DragEvent) => void;
}

export interface TextSpan {
  start: number;
  end: number;
  color: Color;
  background?: Color;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface TextProps {
  style?: Style;
  id?: string;
  onClick?: (event: ClickEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  spans?: TextSpan[];
  children?: React.ReactNode;
}

export interface MarkRef {
  id: number;
  offset: number;
  /**
   * in the case the engine creates the mark (a paste event where it deserializes the bespoke paste format)
   * the application needs to know about the deserialized data to start internally tracking it
   */
  data?: string;
}

export type PasteSource = "clipboard" | "osc" | "file";

export interface PastedImage {
  path: string;
  width: number;
  height: number;
  source: PasteSource;
}

export interface CaretInfo {
  cursor: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ChangeSource = "type" | "paste" | "edit";

export interface ChangeInfo extends CaretInfo {
  source: ChangeSource;
  marks: MarkRef[];
}

export interface InputGutter {
  color: Color;
  activeColor: Color;
}

export interface InputProps {
  style?: Style;
  id?: string;
  defaultValue?: string;
  value?: string;
  defaultMarks?: MarkRef[];
  renderMark?: (id: number) => React.ReactNode;
  serializeMark?: (id: number) => string | undefined;
  caretColor?: Style["color"];
  selectionColor?: Style["color"];
  autoFocus?: boolean;
  spans?: TextSpan[];
  gutter?: InputGutter;
  activeLine?: Color;
  onChange?: (text: string, change: ChangeInfo) => void;
  onCaret?: (caret: CaretInfo) => void;
  onSubmit?: (text: string, marks: MarkRef[]) => void;
  onPasteImage?: (image: PastedImage) => void;
}

export interface MarkedTextProps {
  style?: Style;
  id?: string;
  text: string;
  marks: MarkRef[];
  renderMark?: (id: number) => React.ReactNode;
  serializeMark?: (id: number) => string | undefined;
  onClick?: (event: ClickEvent) => void;
}

export interface ImageAdvancedProps {
  confirmedEqualTo?: string[];
}

export interface ImageProps {
  style?: Style;
  id?: string;
  src: string;
  onClick?: (event: ClickEvent) => void;
  placeholder?: React.ReactNode;
  error?: React.ReactNode;
  advanced?: ImageAdvancedProps;
}

export type AnyProps = BoxProps &
  TextProps &
  InputProps &
  Partial<ImageProps> &
  Partial<Omit<MarkedTextProps, "style" | "id" | "onClick">> &
  Partial<PathProps> & {
    slot?: "placeholder" | "error";
    mark?: number;
  };

export interface Instance {
  id: number;
  bridge: Bridge;
  view: number;
  type: string;
  props: AnyProps;
  parent: Instance | Container | null;
  children: Instance[];
  mounted: boolean;
  hidden: boolean;
  lastSent: string | null;
}

export interface Container {
  bridge: Bridge;
  view: number;
  children: Instance[];
}

type Op = Record<string, unknown>;

export interface FlushSample {
  seq: number;
  view: number;
  ops: number;
  start: number;
  dur: number;
}

export class Bridge {
  engine: NativeEngine;
  propsById: Array<Map<number, AnyProps>> = [new Map(), new Map()];
  containers: Array<Container | null> = [null, null];
  onFlush: ((sample: FlushSample) => void) | null = null;
  onTreeMutation: ((view: number) => void) | null = null;
  private queues: Op[][] = [[], []];
  private nextId = 1;
  private seq = 0;

  constructor(tty: string | undefined, sharedMemoryFrames: boolean) {
    this.engine = createNativeEngine(tty, sharedMemoryFrames);
    if (!defaultBridge) defaultBridge = this;
  }

  allocId(): number {
    return this.nextId++;
  }

  push(view: number, op: Op) {
    this.queues[view].push(op);
  }

  flush() {
    for (let view = 0; view < this.queues.length; view++) {
      const ops = this.queues[view];
      if (ops.length === 0) continue;
      this.queues[view] = [];
      const seq = ++this.seq;
      const payload = JSON.stringify({ view, seq, ops });
      const start = performance.timeOrigin + performance.now();
      this.engine.applyOps(payload);
      if (this.onFlush) {
        const dur = performance.timeOrigin + performance.now() - start;
        this.onFlush({ seq, view, ops: ops.length, start, dur });
      }
    }
  }
}

let defaultBridge: Bridge | null = null;

export function getBridge(): Bridge {
  if (!defaultBridge) defaultBridge = new Bridge(undefined, true);
  return defaultBridge;
}

function textOf(children: React.ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) return children.map(textOf).join("");
  throw new Error("<Text> children must be strings or numbers");
}

function serializeProps(
  type: string,
  props: AnyProps,
  hidden: boolean,
  prevProps?: AnyProps
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    style: serializeStyle(props.style ?? {}),
    key: props.id,
    clickable: !!props.onClick,
    hidden: hidden || !!props.hidden,
    contentHeight: props.contentHeight,
    scrollEvents: !!props.onScroll,
    wheelEvents: !!props.onWheel,
    pointerEvents: !!props.onPointer,
    hoverEvents: !!(props.onMouseEnter || props.onMouseLeave),
    outsideClickEvents: !!props.onClickOutside,
    dragEvents: !!props.onDrag,
    selectionEvents: !!props.onSelection,
    moveEvents: !!props.onMouseMove,
    slot: props.slot,
    mark: props.mark,
    surface: props.surface ? surfaceId(props.surface) : undefined,
  };
  if ((type === "text" || type === "input") && props.spans?.length) {
    base.spans = props.spans.map((s) => ({
      start: s.start,
      end: s.end,
      color: parseColor(s.color),
      background: s.background && parseColor(s.background),
      bold: s.bold,
      italic: s.italic,
      underline: s.underline,
      strikethrough: s.strikethrough,
    }));
  }
  if (type === "shape-path" && props.stroke) {
    base.shape = {
      d: props.d ?? "",
      viewBox: props.viewBox,
      stroke: {
        width: props.stroke.width,
        color: parseColor(props.stroke.color),
        cap: props.stroke.cap,
        join: props.stroke.join,
      },
    };
  }
  if (type === "text") {
    base.text = textOf(props.children);
  } else if (type === "marked-text") {
    base.text = props.text ?? "";
    base.marks = props.marks;
  } else if (type === "image") {
    base.image = {
      src: props.src ?? "",
      confirmedEqualTo: props.advanced?.confirmedEqualTo,
    };
  } else if (type === "input") {
    const valueChanged = !prevProps || props.value !== prevProps.value;
    base.input = {
      initial: props.defaultValue ?? props.value ?? "",
      value: valueChanged ? props.value : undefined,
      marks: props.defaultMarks,
      caretColor: parseColor(props.caretColor),
      selectionColor: parseColor(props.selectionColor),
      autoFocus: !!props.autoFocus,
      submit: !!props.onSubmit,
      gutter: props.gutter && {
        color: parseColor(props.gutter.color),
        activeColor: parseColor(props.gutter.activeColor),
      },
      activeLine: parseColor(props.activeLine),
    };
  }
  return base;
}

function mutated(b: Bridge, view: number) {
  b.onTreeMutation?.(view);
}

function pushPropsIfChanged(
  instance: Instance,
  serialized: Record<string, unknown>
): boolean {
  const json = JSON.stringify(serialized);
  if (json === instance.lastSent) return false;
  instance.lastSent = json;
  instance.bridge.push(instance.view, {
    op: "update",
    id: instance.id,
    props: serialized,
  });
  return true;
}

function materialize(b: Bridge, instance: Instance) {
  if (instance.mounted) return;
  instance.mounted = true;
  const serialized = serializeProps(instance.type, instance.props, instance.hidden);
  instance.lastSent = JSON.stringify(serialized);
  b.push(instance.view, {
    op: "create",
    id: instance.id,
    props: serialized,
  });
  for (const child of instance.children) {
    materialize(b, child);
    b.push(instance.view, {
      op: "insertBefore",
      parent: instance.id,
      child: child.id,
      before: null,
    });
  }
}

function detachFromParent(child: Instance) {
  const parent = child.parent;
  if (!parent) return;
  const index = parent.children.indexOf(child);
  if (index !== -1) parent.children.splice(index, 1);
  child.parent = null;
}

function insert(
  parent: Instance | Container,
  parentId: number,
  child: Instance,
  before: Instance | null
) {
  const b = child.bridge;
  materialize(b, child);
  detachFromParent(child);
  const siblings = parent.children;
  const at = before ? siblings.indexOf(before) : -1;
  if (at === -1) siblings.push(child);
  else siblings.splice(at, 0, child);
  child.parent = parent;
  b.push(child.view, {
    op: "insertBefore",
    parent: parentId,
    child: child.id,
    before: before?.id ?? null,
  });
  mutated(b, child.view);
}

function remove(child: Instance) {
  detachFromParent(child);
  child.bridge.push(child.view, { op: "remove", id: child.id });
  mutated(child.bridge, child.view);
}

const CONTAINER_NODE_ID = 0;

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1 as const,

  createInstance(type: string, props: AnyProps, rootContainer: Container): Instance {
    const b = rootContainer.bridge;
    const instance: Instance = {
      id: b.allocId(),
      bridge: b,
      view: rootContainer.view,
      type,
      props,
      parent: null,
      children: [],
      mounted: false,
      hidden: false,
      lastSent: null,
    };
    b.propsById[instance.view].set(instance.id, props);
    return instance;
  },

  createTextInstance(): never {
    throw new Error("Raw text must be wrapped in <Text>");
  },

  shouldSetTextContent(type: string): boolean {
    return type === "text";
  },

  appendInitialChild(parent: Instance, child: Instance) {
    parent.children.push(child);
    child.parent = parent;
  },

  finalizeInitialChildren(): boolean {
    return false;
  },

  prepareUpdate(
    _instance: Instance,
    _type: string,
    _oldProps: AnyProps,
    newProps: AnyProps
  ): AnyProps {
    return newProps;
  },

  commitUpdate(
    instance: Instance,
    newProps: AnyProps,
    _type: string,
    oldProps: AnyProps
  ) {
    const b = instance.bridge;
    const prevProps = instance.props;
    instance.props = newProps;
    b.propsById[instance.view].set(instance.id, newProps);
    const serialized = serializeProps(
      instance.type,
      newProps,
      instance.hidden,
      oldProps ?? prevProps
    );
    if (pushPropsIfChanged(instance, serialized)) {
      mutated(instance.bridge, instance.view);
    }
  },

  appendChild(parent: Instance, child: Instance) {
    insert(parent, parent.id, child, null);
  },

  appendChildToContainer(container: Container, child: Instance) {
    insert(container, CONTAINER_NODE_ID, child, null);
  },

  insertBefore(parent: Instance, child: Instance, before: Instance) {
    insert(parent, parent.id, child, before);
  },

  insertInContainerBefore(container: Container, child: Instance, before: Instance) {
    insert(container, CONTAINER_NODE_ID, child, before);
  },

  removeChild(_parent: Instance, child: Instance) {
    remove(child);
  },

  removeChildFromContainer(_container: Container, child: Instance) {
    remove(child);
  },

  clearContainer(container: Container) {
    container.children = [];
    container.bridge.push(container.view, { op: "clear", id: CONTAINER_NODE_ID });
    mutated(container.bridge, container.view);
  },

  detachDeletedInstance(instance: Instance) {
    const b = instance.bridge;
    b.propsById[instance.view].delete(instance.id);
    b.push(instance.view, { op: "forget", id: instance.id });
  },

  hideInstance(instance: Instance) {
    instance.hidden = true;
    const serialized = serializeProps(instance.type, instance.props, true, instance.props);
    if (pushPropsIfChanged(instance, serialized)) {
      mutated(instance.bridge, instance.view);
    }
  },

  unhideInstance(instance: Instance, props: AnyProps) {
    const prevProps = instance.props;
    instance.hidden = false;
    instance.props = props;
    const serialized = serializeProps(instance.type, props, false, prevProps);
    if (pushPropsIfChanged(instance, serialized)) {
      mutated(instance.bridge, instance.view);
    }
  },

  hideTextInstance() {},
  unhideTextInstance() {},
  commitTextUpdate() {},
  resetTextContent() {},
  commitMount() {},

  getRootHostContext(): null {
    return null;
  },

  getChildHostContext(parentContext: null): null {
    return parentContext;
  },

  getPublicInstance(instance: Instance) {
    const type = instance.type;
    return {
      id: instance.id,
      focus: () => {
        if (type !== "input") return;
        const b = instance.bridge;
        b.push(instance.view, { op: "focus", id: instance.id });
        b.flush();
      },
      blur: () => {
        if (type !== "input") return;
        const b = instance.bridge;
        b.push(instance.view, { op: "focus", id: null });
        b.flush();
      },
      scrollTo: (offset: number, smooth = false) => {
        const b = instance.bridge;
        b.push(instance.view, { op: "scrollTo", id: instance.id, offset, smooth });
        b.flush();
      },
      scrollIntoView: (smooth = false) => {
        const b = instance.bridge;
        b.push(instance.view, { op: "scrollIntoView", id: instance.id, smooth });
        b.flush();
      },
      splice: (start: number, end: number, text: string) => {
        if (type !== "input") return;
        const b = instance.bridge;
        b.push(instance.view, { op: "inputSplice", id: instance.id, start, end, text });
        b.flush();
      },
      selectAll: () => {
        if (type !== "input") return;
        const b = instance.bridge;
        b.push(instance.view, { op: "inputSelectAll", id: instance.id });
        b.flush();
      },
      addMark: (mark: number, offset?: number) => {
        if (type !== "input") return;
        const b = instance.bridge;
        b.push(instance.view, { op: "insertMark", id: instance.id, mark, offset });
        b.flush();
      },
      removeMark: (mark: number) => {
        if (type !== "input") return;
        const b = instance.bridge;
        b.push(instance.view, { op: "removeMark", id: instance.id, mark });
        b.flush();
      },
    };
  },

  prepareForCommit(): null {
    return null;
  },

  resetAfterCommit(container: Container) {
    container.bridge.flush();
  },

  preparePortalMount() {},

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,

  getCurrentEventPriority(): number {
    return DefaultEventPriority;
  },

  getInstanceFromNode(): null {
    return null;
  },

  getInstanceFromScope(): null {
    return null;
  },

  prepareScopeUpdate() {},
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reconciler = Reconciler(hostConfig as any);
