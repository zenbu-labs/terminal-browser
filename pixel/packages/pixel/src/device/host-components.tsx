import { createElement, forwardRef } from "react";
import type { ComponentType, ReactElement, ReactNode, RefAttributes } from "react";

import { Box, Input as PixelInput, Path } from "../react/components";
import type { NodeHandle } from "../react/components";
import type { InputProps } from "../react/reconciler-config";
import type { Color, Style } from "../react/styles";

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

export interface AccessoryMenuItem {
  id: string;
  title: string;
  symbol?: string;
}

export interface ComposerInputProps extends InputProps {
  markLabel?(id: number): string;
  accessories?: { leading?: "plus"; trailing?: "send" | "stop" };
  accessoryMenu?: AccessoryMenuItem[];
  onAccessory?(name: string): void;
}

export type NativeInputProps = Pick<
  ComposerInputProps,
  "style" | "defaultValue" | "value" | "defaultMarks" | "autoFocus" | "onChange" | "onCaret" | "onSubmit" | "markLabel" | "accessories" | "accessoryMenu" | "onAccessory"
>;

export interface MenuItem {
  id: string;
  title: string;
  subtitle?: string;
  symbol?: string;
  checked?: boolean;
  children?: MenuItem[];
  inline?: boolean;
}

export interface NativeMenuProps {
  items: MenuItem[];
  onSelect(id: string): void;
  children: ReactNode;
  style?: Style;
}

export interface ToolbarItem {
  id: string;
  label: string;
  symbol: string;
  icon?: string;
  roomy?: boolean;
}

export interface ToolbarProps {
  items: ToolbarItem[];
  onPress(id: string): void;
  style?: Style;
  color?: Color;
  background?: Color;
}

export interface HostComponents {
  Toolbar?: ComponentType<ToolbarProps>;
  NativeMenu?: ComponentType<NativeMenuProps>;
  Input?: ComponentType<NativeInputProps & RefAttributes<NodeHandle>>;
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

export const Input = forwardRef<NodeHandle, ComposerInputProps>(function Input(props, ref) {
  const Native = registered.Input;
  if (Native) return createElement(Native, { ...props, ref });
  const { markLabel: _label, accessories: _accessories, accessoryMenu: _menu, onAccessory: _onAccessory, ...rest } = props;
  return createElement(PixelInput, { ...rest, ref });
});

export function NativeMenu(props: NativeMenuProps): ReactElement {
  const Native = registered.NativeMenu;
  return Native ? createElement(Native, props) : createElement(Box, { style: props.style }, props.children);
}

export function Toolbar(props: ToolbarProps): ReactElement {
  const Native = registered.Toolbar;
  if (Native) return createElement(Native, props);
  const height = typeof props.style?.height === "number" ? props.style.height : 32;
  const icon = Math.round(height * 0.55);
  return createElement(
    Box,
    {
      style: {
        flexDirection: "row",
        alignItems: "center",
        height,
        cornerRadius: height / 2,
        padding: { left: height * 0.2, right: height * 0.2 },
        background: props.background ?? [40, 40, 44, 230],
        ...props.style,
      },
    },
    props.items
      .filter((item) => !item.roomy)
      .map((item) =>
        createElement(
          Box,
          { key: item.id, style: { width: height, height, alignItems: "center", justifyContent: "center", pointerShape: "pointer" }, onClick: () => props.onPress(item.id) },
          item.icon
            ? createElement(Path, {
                d: item.icon,
                viewBox: 24,
                stroke: { width: 2, color: props.color ?? [235, 235, 240, 255], cap: "round", join: "round" },
                style: { width: icon, height: icon, flexShrink: 0 },
              })
            : null,
        ),
      ),
  );
}
