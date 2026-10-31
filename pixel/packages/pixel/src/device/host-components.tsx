import { createElement, forwardRef } from "react";
import type { ComponentType, ReactElement, RefAttributes } from "react";

import { Box } from "../react/components";
import type { Style } from "../react/styles";

export interface WebViewHandle {
  focus(): void;
  blur(): void;
}

export interface WebViewProps {
  src: string;
  style?: Style;
  hidden?: boolean;
  inline?: boolean;
  onContentHeight?(height: number): void;
  onFocusChange?(focused: boolean): void;
}

export interface VideoProps {
  src: string;
  headers?: Record<string, string>;
  paused?: boolean;
  muted?: boolean;
  loop?: boolean;
  timeMs?: number;
  onTime?(timeMs: number, durationMs: number): void;
  onEnd?(): void;
  style?: Style;
}

export interface HostComponents {
  WebView?: ComponentType<WebViewProps & RefAttributes<WebViewHandle>>;
  Video?: ComponentType<VideoProps>;
}

const registered: HostComponents = {};

export function registerHostComponents(components: HostComponents): void {
  Object.assign(registered, components);
}

export function hostHas(name: keyof HostComponents): boolean {
  return registered[name] != null;
}

export const WebView = forwardRef<WebViewHandle, WebViewProps>(function WebView(props, ref) {
  const Native = registered.WebView;
  return Native ? createElement(Native, { ...props, ref }) : createElement(Box, { style: props.style, hidden: props.hidden });
});

export function Video(props: VideoProps): ReactElement {
  const Native = registered.Video;
  return Native ? createElement(Native, props) : createElement(Box, { style: props.style });
}
