import {
  cloneElement,
  createElement,
  forwardRef,
  isValidElement,
  useState,
  type ForwardRefExoticComponent,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
} from "react";

import type {
  BoxProps,
  EllipseProps,
  ImageProps,
  InputProps,
  MarkedTextProps,
  MarkRef,
  PathProps,
  PolylineProps,
  RectProps,
  SceneImageProps,
  SceneProps,
  SceneTextProps,
  TextProps,
} from "./reconciler-config";

export interface NodeHandle {
  id: number;
  focus(): void;
  blur(): void;
  scrollTo(offset: number, smooth?: boolean): void;
  scrollIntoView(smooth?: boolean): void;
  splice(start: number, end: number, text: string): void;
  selectAll(): void;
  addMark(mark: number, offset?: number): void;
  removeMark(mark: number): void;
  /** Extends a <Polyline> with flat [x, y, ...] world points, bypassing React —
   * for the hot path of an in-progress pen stroke. The owner must fold the
   * points into its `points` prop before the next commit or they are lost. */
  appendPoints(points: number[]): void;
}

type Host<P> = ForwardRefExoticComponent<P & RefAttributes<NodeHandle>>;

export const Box = "box" as unknown as Host<BoxProps>;
export const Text = "text" as unknown as Host<TextProps>;
export const Scene = "scene" as unknown as Host<SceneProps>;
export const Rect = "shape-rect" as unknown as Host<RectProps>;
export const Ellipse = "shape-ellipse" as unknown as Host<EllipseProps>;
export const Polyline = "shape-polyline" as unknown as Host<PolylineProps>;
export const Path = "shape-path" as unknown as Host<PathProps>;
export const SceneText = "shape-text" as unknown as Host<SceneTextProps>;
export const SceneImage = "shape-image" as unknown as Host<SceneImageProps>;

function markWidgets(
  marks: readonly MarkRef[],
  renderMark: ((id: number) => ReactNode) | undefined
): ReactNode {
  if (!renderMark) return null;
  return marks.map((mark) =>
    createElement("box", { key: mark.id, mark: mark.id }, renderMark(mark.id))
  );
}

const InputHost = "input" as unknown as Host<InputProps>;

export const Input = forwardRef<NodeHandle, InputProps>(function Input(props, ref) {
  const { renderMark, onChange, ...rest } = props;
  const [marks, setMarks] = useState<MarkRef[]>(props.defaultMarks ?? []);
  return createElement(
    InputHost,
    {
      ...rest,
      ref,
      onChange: (text, change) => {
        setMarks(change.marks);
        onChange?.(text, change)
      },
    },
    markWidgets(marks, renderMark)
  );
});

const MarkedTextHost = "marked-text" as unknown as Host<MarkedTextProps>;

export const MarkedText = forwardRef<NodeHandle, MarkedTextProps>(function MarkedText(
  props,
  ref
) {
  const { renderMark, ...rest } = props;
  return createElement(
    MarkedTextHost,
    { ...rest, ref },
    markWidgets(props.marks, renderMark)
  );
});

function slotted(kind: "placeholder" | "error", content: ReactNode): ReactElement | null {
  if (content == null || typeof content === "boolean") return null;
  if (isValidElement(content) && typeof content.type === "string") {
    return cloneElement(content as ReactElement<{ slot?: string }>, {
      key: kind,
      slot: kind,
    });
  }
  return createElement("box", { key: kind, slot: kind }, content);
}

export const Image = forwardRef<NodeHandle, ImageProps>(function Image(props, ref) {
  const { placeholder, error, ...rest } = props;
  return createElement(
    "image",
    { ...rest, ref },
    slotted("placeholder", placeholder),
    slotted("error", error)
  );
});
