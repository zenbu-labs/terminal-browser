import Reconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants";

import { createNativeEngine, NativeEngine } from "./native";
import { parseColor, serializeStyle, Style } from "./styles";

export const APP_VIEW = 0;
export const DEVTOOLS_VIEW = 1;

export interface ClickEvent {
  x: number;
  y: number;
}

export interface ScrollEvent {
  offset: number;
  max: number;
}

export interface WheelEvent {
  /** Position within the node, in px. */
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  precise: boolean;
}

export interface BoxProps {
  style?: Style;
  id?: string;
  onClick?: (event: ClickEvent) => void;
  onScroll?: (event: ScrollEvent) => void;
  /** Receive raw wheel input instead of engine scrolling. */
  onWheel?: (event: WheelEvent) => void;
  contentHeight?: number;
  children?: React.ReactNode;
}

export interface TextProps {
  style?: Style;
  id?: string;
  onClick?: (event: ClickEvent) => void;
  children?: React.ReactNode;
}

export interface InputProps {
  style?: Style;
  id?: string;
  defaultValue?: string;
  value?: string;
  caretColor?: Style["color"];
  selectionColor?: Style["color"];
  autoFocus?: boolean;
  onChange?: (text: string) => void;
  onSubmit?: (text: string) => void;
}

export type AnyProps = BoxProps & TextProps & InputProps;

export interface Instance {
  id: number;
  view: number;
  type: string;
  props: AnyProps;
  parent: Instance | Container | null;
  children: Instance[];
  mounted: boolean;
  hidden: boolean;
  /** Serialized form of the last props sent to the engine. */
  lastSent: string | null;
}

export interface Container {
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
  engine: NativeEngine = createNativeEngine();
  propsById: Array<Map<number, AnyProps>> = [new Map(), new Map()];
  containers: Array<Container | null> = [null, null];
  onFlush: ((sample: FlushSample) => void) | null = null;
  onTreeMutation: ((view: number) => void) | null = null;
  private queues: Op[][] = [[], []];
  private nextId = 1;
  private seq = 0;

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

let bridge: Bridge | null = null;

export function getBridge(): Bridge {
  if (!bridge) bridge = new Bridge();
  return bridge;
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
    hidden,
    contentHeight: props.contentHeight,
    scrollEvents: !!props.onScroll,
    wheelEvents: !!props.onWheel,
  };
  if (type === "text") {
    base.text = textOf(props.children);
  } else if (type === "input") {
    const valueChanged = !prevProps || props.value !== prevProps.value;
    base.input = {
      initial: props.defaultValue ?? props.value ?? "",
      value: valueChanged ? props.value : undefined,
      caretColor: parseColor(props.caretColor),
      selectionColor: parseColor(props.selectionColor),
      autoFocus: !!props.autoFocus,
      submit: !!props.onSubmit,
    };
  }
  return base;
}

function mutated(view: number) {
  getBridge().onTreeMutation?.(view);
}

/**
 * React re-renders hand us fresh props objects even when nothing changed, so
 * an update op per host element per commit would flood the engine (a 60Hz
 * animation over a big static list serializes megabytes per second). Compare
 * the serialized form against what the engine already has and skip no-ops.
 */
function pushPropsIfChanged(
  instance: Instance,
  serialized: Record<string, unknown>
): boolean {
  const json = JSON.stringify(serialized);
  if (json === instance.lastSent) return false;
  instance.lastSent = json;
  getBridge().push(instance.view, {
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
  const b = getBridge();
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
  mutated(child.view);
}

function remove(child: Instance) {
  detachFromParent(child);
  getBridge().push(child.view, { op: "remove", id: child.id });
  mutated(child.view);
}

const CONTAINER_NODE_ID = 0;

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1 as const,

  createInstance(type: string, props: AnyProps, rootContainer: Container): Instance {
    const b = getBridge();
    const instance: Instance = {
      id: b.allocId(),
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
    const b = getBridge();
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
      mutated(instance.view);
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
    getBridge().push(container.view, { op: "clear", id: CONTAINER_NODE_ID });
    mutated(container.view);
  },

  detachDeletedInstance(instance: Instance) {
    const b = getBridge();
    b.propsById[instance.view].delete(instance.id);
    b.push(instance.view, { op: "forget", id: instance.id });
  },

  hideInstance(instance: Instance) {
    instance.hidden = true;
    const serialized = serializeProps(instance.type, instance.props, true, instance.props);
    if (pushPropsIfChanged(instance, serialized)) {
      mutated(instance.view);
    }
  },

  unhideInstance(instance: Instance, props: AnyProps) {
    const prevProps = instance.props;
    instance.hidden = false;
    instance.props = props;
    const serialized = serializeProps(instance.type, props, false, prevProps);
    if (pushPropsIfChanged(instance, serialized)) {
      mutated(instance.view);
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
    return {
      id: instance.id,
      focus: () => {
        const b = getBridge();
        b.push(instance.view, { op: "focus", id: instance.id });
        b.flush();
      },
      blur: () => {
        const b = getBridge();
        b.push(instance.view, { op: "focus", id: null });
        b.flush();
      },
      scrollTo: (offset: number, smooth = false) => {
        const b = getBridge();
        b.push(instance.view, { op: "scrollTo", id: instance.id, offset, smooth });
        b.flush();
      },
    };
  },

  prepareForCommit(): null {
    return null;
  },

  resetAfterCommit() {
    getBridge().flush();
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
