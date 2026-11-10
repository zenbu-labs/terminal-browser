import type { Container } from "../reconciler-config";
import { profilerStore, recordSpan } from "./stores";

const PERFORMED_WORK = 0b1;

interface FiberLike {
  tag: number;
  type: unknown;
  flags: number;
  actualStartTime?: number;
  actualDuration?: number;
  child: FiberLike | null;
  sibling: FiberLike | null;
}

interface FiberRootLike {
  current: FiberLike;
  containerInfo?: Container;
}

function fiberName(fiber: FiberLike): string | null {
  const type = fiber.type as
    | string
    | null
    | (((...args: unknown[]) => unknown) & { displayName?: string })
    | { $$typeof?: symbol; render?: { name?: string }; type?: unknown; displayName?: string };
  if (typeof type === "string") return `<${type}>`;
  if (typeof type === "function") return type.displayName || type.name || "Anonymous";
  if (type && typeof type === "object") {
    if (type.displayName) return type.displayName;
    const render = type.render;
    if (render) return render.name || "ForwardRef";
    if (type.type) {
      return fiberName({ ...fiber, type: type.type });
    }
  }
  return null;
}

function didRender(fiber: FiberLike): boolean {
  return (
    (fiber.flags & PERFORMED_WORK) !== 0 &&
    typeof fiber.actualDuration === "number" &&
    typeof fiber.actualStartTime === "number" &&
    fiber.actualStartTime > 0
  );
}

function collect(fiber: FiberLike | null, depth: number, epoch: number) {
  for (let node = fiber; node; node = node.sibling) {
    let childDepth = depth;
    if (didRender(node)) {
      const name = fiberName(node);
      if (name) {
        let childTotal = 0;
        for (let child = node.child; child; child = child.sibling) {
          if (didRender(child)) childTotal += child.actualDuration ?? 0;
        }
        const dur = node.actualDuration ?? 0;
        recordSpan({
          name,
          start: epoch + (node.actualStartTime ?? 0),
          dur,
          depth,
          lane: "react",
          self: Math.max(0, dur - childTotal),
        });
        childDepth = depth + 1;
      }
    }
    collect(node.child, childDepth, epoch);
  }
}

interface DevtoolsHook {
  isDisabled: boolean;
  supportsFiber: boolean;
  renderers: Map<number, unknown>;
  inject(renderer: unknown): number;
  onCommitFiberRoot(rendererId: number, root: FiberRootLike): void;
  onCommitFiberUnmount(): void;
  onPostCommitFiberRoot(): void;
  onScheduleFiberRoot?(): void;
}

let installed = false;

export function installFiberHook() {
  if (installed) return;
  installed = true;
  const globals = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook };
  if (globals.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
  const hook: DevtoolsHook = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(_rendererId, root) {
      if (!profilerStore.get().recording) return;
      if (root.containerInfo?.view !== 0) return;
      try {
        collect(root.current.child, 0, performance.timeOrigin);
      } catch {
      }
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
  };
  globals.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
}
