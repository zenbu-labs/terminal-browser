import type { ForwardRefExoticComponent, RefAttributes } from "react";

import type { BoxProps, InputProps, TextProps } from "./host-config";

export interface NodeHandle {
  id: number;
  focus(): void;
  blur(): void;
  scrollTo(offset: number, smooth?: boolean): void;
}

type Host<P> = ForwardRefExoticComponent<P & RefAttributes<NodeHandle>>;

export const Box = "box" as unknown as Host<BoxProps>;
export const Text = "text" as unknown as Host<TextProps>;
export const Input = "input" as unknown as Host<InputProps>;
