import { useState } from "react";
import { Box, Text } from "@zenbu-labs/pixel";
import type { Rgba } from "@zenbu-labs/pixel";
import { measureText } from "../record/model";
import type { InteractionKind, RecordView } from "../record/types";
import { displayUrl } from "../url";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { DismissButton } from "./record-widgets";
import { mix, withAlpha } from "./theme";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout } from "./types";

const INTERACTION_ICONS: Record<InteractionKind, IconName> = {
  click: "cursor",
  link: "arrow",
  reload: "reload",
  load: "bolt",
};

function interactionColor(kind: InteractionKind, theme: Theme): Rgba {
  switch (kind) {
    case "click":
      return theme.accent;
    case "link":
      return theme.green;
    case "reload":
      return theme.magenta;
    case "load":
      return theme.cyan;
  }
}

const INTERACTION_LABELS: Record<InteractionKind, string> = {
  click: "Click",
  link: "Link opened",
  reload: "Reload",
  load: "Page load",
};

/** hover tooltip above a track marker, centered on the marker's box */
function TrackTip({
  label,
  parentWidth,
  bottom,
  border,
  rem,
  theme,
}: {
  label: string;
  parentWidth: number;
  bottom: number;
  border: Rgba;
  rem: number;
  theme: Theme;
}) {
  const width = measureText(label, rem * 0.62).width + rem * 0.7;
  return (
    <Box
      style={{
        position: "absolute",
        inset: { bottom, left: (parentWidth - width) / 2 },
        width,
        height: rem * 1.15,
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: rem * 0.3,
        background: theme.field,
        border: { width: 1, color: border },
      }}
    >
      <Text style={{ fontSize: rem * 0.62, color: theme.fg, wrap: false, selectable: false }}>
        {label}
      </Text>
    </Box>
  );
}

function TrackIcon({
  icon,
  color,
  label,
  x,
  trackY,
  rem,
  theme,
  onClick,
}: {
  icon: IconName;
  color: Rgba;
  label: string;
  x: number;
  trackY: number;
  rem: number;
  theme: Theme;
  onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: x - rem * 0.4, top: trackY - rem * 0.95 },
        width: rem * 0.8,
        height: rem * 0.8,
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <Icon icon={icon} size={rem * 0.7} weight={2.8} color={color} />
      {hover && (
        <TrackTip
          label={label}
          parentWidth={rem * 0.8}
          bottom={rem * 0.95}
          border={theme.fieldBorder}
          rem={rem}
          theme={theme}
        />
      )}
    </Box>
  );
}

function DropMark({
  count,
  x,
  trackY,
  trackH,
  rem,
  theme,
}: {
  count: number;
  x: number;
  trackY: number;
  trackH: number;
  rem: number;
  theme: Theme;
}) {
  const [hover, setHover] = useState(false);
  const label = `${count} frame${count === 1 ? "" : "s"} dropped`;
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: x - rem * 0.25, top: trackY - 3 },
        width: rem * 0.5,
        height: trackH + 6,
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Box
        style={{
          width: 3,
          height: trackH + 6,
          cornerRadius: 1.5,
          background: theme.red,
        }}
      />
      {hover && (
        <TrackTip
          label={label}
          parentWidth={rem * 0.5}
          bottom={trackH + 8}
          border={theme.red}
          rem={rem}
          theme={theme}
        />
      )}
    </Box>
  );
}

export interface RecordBarMetrics {
  y: number;
  height: number;
  track: { x: number; width: number };
  strip: { y: number; height: number };
}

export interface ClusterContents {
  minutes: boolean;
}

export function recordBarCluster(durationMs: number): ClusterContents {
  return { minutes: durationMs >= 60000 };
}

const PLAY_CLUSTER_REM = 5.4;

export function recordBarMetrics(layout: ChromeLayout, cluster: ClusterContents): RecordBarMetrics {
  const rem = layout.rem;
  const height = layout.recordBarHeight;
  const pad = rem * 0.75;
  const trackX = pad + rem * PLAY_CLUSTER_REM;
  const timeSample = formatMs(0, cluster.minutes);
  const timeWidth = measureText(`${timeSample} / ${timeSample}`, rem * 0.7).width;
  const clusterReserve = rem * 0.85 + timeWidth;
  const trackWidth = Math.max(40, layout.width - trackX - clusterReserve - pad);
  const stripY = Math.round(rem * 1.2);
  return {
    y: layout.height - height,
    height,
    track: { x: trackX, width: trackWidth },
    strip: { y: stripY, height: Math.max(8, height - stripY - Math.round(rem * 0.45)) },
  };
}

function formatMs(ms: number, withMinutes: boolean): string {
  const clamped = Math.max(0, Math.round(ms));
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = String(clamped % 1000).padStart(3, "0");
  if (!withMinutes) return `${seconds}.${millis}`;
  return `${Math.floor(clamped / 60000)}:${String(seconds).padStart(2, "0")}.${millis}`;
}

export function RecordBar({
  view,
  actions,
  layout,
  theme,
}: {
  view: RecordView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cluster = recordBarCluster(view.durationMs);
  const withMinutes = cluster.minutes;
  const metrics = recordBarMetrics(layout, cluster);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: metrics.y, left: 0 },
        width: layout.width,
        height: metrics.height,
      }}
    >
      <Box
        style={{
          position: "absolute",
          inset: {
            left: rem * 0.5,
            top: metrics.strip.y + (metrics.strip.height - rem * 2.3) / 2,
          },
          height: rem * 2.3,
          alignItems: "center",
          gap: rem * 0.25,
          padding: { left: rem * 0.6, right: rem * 0.7 },
          cornerRadius: (rem * 2.3) / 2,
          hoverBackground: theme.hover,
        }}
        onClick={actions.record.playToggle}
      >
        <Icon
          icon={view.playing ? "pause" : "play"}
          size={rem * 1.55}
          color={view.playing ? theme.fg : withAlpha(theme.fg, 220)}
        />
        <Text style={{ fontSize: rem * 0.65, color: theme.muted, wrap: false, selectable: false }}>
          space
        </Text>
      </Box>
      <Track
        view={view}
        actions={actions}
        theme={theme}
        rem={rem}
        metrics={metrics}
        scrubFrac={view.thumbFrac}
        withMinutes={withMinutes}
      />
      <Box
        style={{
          position: "absolute",
          inset: { right: rem * 0.4, top: metrics.strip.y },
          height: metrics.strip.height,
          alignItems: "center",
          gap: rem * 0.45,
        }}
      >
        <Text style={{ fontSize: rem * 0.7, color: theme.muted, wrap: false, selectable: false }}>
          {view.stopped
            ? `${formatMs(view.timeMs, withMinutes)} / ${formatMs(view.durationMs, withMinutes)}`
            : formatMs(view.durationMs, withMinutes)}
        </Text>
      </Box>
    </Box>
  );
}

function ShotTick({
  shot,
  x,
  trackY,
  trackH,
  rem,
  theme,
  actions,
  active,
  drawn,
}: {
  shot: RecordView["shots"][number];
  x: number;
  trackY: number;
  trackH: number;
  rem: number;
  theme: Theme;
  actions: ChromeActions;
  active: boolean;
  drawn: boolean;
}) {
  const [hover, setHover] = useState(false);
  const width = rem * 1.3;
  const buttonZone = rem * 1.4;
  const top = trackY - rem * 0.95 - buttonZone;
  const height = trackY + trackH + 6 - top;
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: x - width / 2, top },
        width,
        height,
        flexDirection: "column",
        alignItems: "center",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Box
        style={{ height: buttonZone, alignItems: "center", justifyContent: "center", flexShrink: 0 }}
      >
        {hover && (
          <DismissButton rem={rem} theme={theme} onClick={() => actions.record.dismissShot(shot.tMs)} />
        )}
      </Box>
      <Box
        style={{
          flexGrow: 1,
          width,
          flexDirection: "column",
          alignItems: "center",
        }}
        onClick={() => actions.record.seek(shot.tMs)}
      >
        {drawn ? (
          <Box style={{ height: rem * 0.7, flexShrink: 0 }} />
        ) : (
          <Icon
            icon="camera"
            size={rem * 0.7}
            weight={2.8}
            color={active ? theme.accent : withAlpha(theme.fg, 240)}
          />
        )}
        <Box
          style={{
            width: active ? 4 : 3,
            flexGrow: 1,
            cornerRadius: 1.5,
            background: active ? theme.accent : withAlpha(theme.fg, 220),
          }}
        />
      </Box>
    </Box>
  );
}

function ShotThumb({
  view,
  rem,
  theme,
}: {
  view: RecordView;
  rem: number;
  theme: Theme;
}) {
  if (!view.shotThumb) return null;
  const stacked = view.keyframeCount > 1;
  const thumbH = rem * 1.35;
  const thumbW = Math.round(
    Math.max(rem * 0.9, Math.min(rem * 2.4, thumbH / Math.max(0.2, view.frameAspect))),
  );
  return (
    <Box style={{ width: thumbW + 4, height: thumbH + 4, flexShrink: 0 }}>
      {stacked && (
        <Box
          style={{
            position: "absolute",
            inset: { left: 4, top: 4 },
            width: thumbW,
            height: thumbH,
            cornerRadius: 3,
            background: theme.hoverStrong,
            border: { width: 1, color: theme.fieldBorder },
          }}
        />
      )}
      <Box
        style={{
          position: "absolute",
          inset: { left: 0, top: 0 },
          width: thumbW,
          height: thumbH,
          cornerRadius: 3,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
      >
        <Box
          surface={view.shotThumb}
          style={{
            position: "absolute",
            inset: { top: 0, left: 0 },
            width: thumbW,
            height: thumbH,
          }}
        />
      </Box>
      {stacked && (
        <Box
          style={{
            position: "absolute",
            inset: { right: -4, top: -5 },
            height: rem * 0.85,
            padding: { left: rem * 0.25, right: rem * 0.25 },
            alignItems: "center",
            cornerRadius: rem * 0.42,
            background: theme.fg,
          }}
        >
          <Text
            style={{
              fontSize: rem * 0.55,
              color: theme.overlay,
              wrap: false,
              selectable: false,
            }}
          >
            {String(view.keyframeCount)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

const DASH_PITCH = 8;
const DASH_WIDTH = 4;

function TrimHandle({
  x,
  strip,
  rem,
  theme,
  onDrag,
}: {
  x: number;
  strip: { y: number; height: number };
  rem: number;
  theme: Theme;
  onDrag: (event: Parameters<ChromeActions["record"]["trackDrag"]>[0]) => void;
}) {
  const width = Math.round(rem * 0.55);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: x - width / 2, top: strip.y - 3 },
        width,
        height: strip.height + 6,
        cornerRadius: 4,
        background: theme.accent,
        alignItems: "center",
        justifyContent: "center",
      }}
      onDrag={onDrag}
    >
      <Box
        style={{
          width: 2,
          height: strip.height * 0.45,
          cornerRadius: 1,
          background: [255, 255, 255, 220],
        }}
      />
    </Box>
  );
}

function Track({
  view,
  actions,
  theme,
  rem,
  metrics,
  scrubFrac,
  withMinutes,
}: {
  view: RecordView;
  actions: ChromeActions;
  theme: Theme;
  rem: number;
  metrics: RecordBarMetrics;
  scrubFrac: number;
  withMinutes: boolean;
}) {
  const [thumbHover, setThumbHover] = useState(false);
  const strip = metrics.strip;
  const trackY = strip.y;
  const trackH = strip.height;
  const trackW = metrics.track.width;
  const scrubX = Math.round(trackW * scrubFrac);
  const duration = Math.max(1, view.durationMs);
  const xAt = (tMs: number) => Math.round(trackW * Math.min(1, tMs / duration));
  const startX = xAt(view.trim?.startMs ?? 0);
  const endX = xAt(view.trim?.endMs ?? duration);
  const thumbActive = thumbHover || view.scrubbing;
  const thumbW = thumbActive ? 7 : 5;
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: metrics.track.x, top: 0 },
        width: trackW,
        height: metrics.height,
      }}
      onDrag={actions.record.trackDrag}
    >
      <Box
        style={{
          position: "absolute",
          inset: { left: 0, top: strip.y },
          width: trackW,
          height: strip.height,
          cornerRadius: 6,
          overflow: "hidden",
          background: withAlpha([0, 0, 0, 255], 89),
          border: { width: 1, color: theme.fieldBorder },
        }}
      >
        {view.filmstrip && (
          <Box
            surface={view.filmstrip}
            style={{
              position: "absolute",
              inset: { left: 0, top: 0 },
              width: trackW,
              height: strip.height,
            }}
          />
        )}
        {view.gaps.map((gap) => {
          const left = Math.round(trackW * gap.startFrac);
          const width = Math.max(1, Math.round(trackW * gap.endFrac) - left);
          const dashes: number[] = [];
          for (let x = left + 2; x + DASH_WIDTH <= left + width - 2; x += DASH_PITCH) dashes.push(x);
          return (
            <Box key={left} style={{ position: "absolute", inset: { left: 0, top: 0 } }}>
              {dashes.map((x) => (
                <Box
                  key={x}
                  style={{
                    position: "absolute",
                    inset: { left: x, top: strip.height - 6 },
                    width: DASH_WIDTH,
                    height: 3,
                    cornerRadius: 1.5,
                    background: withAlpha(theme.fg, 150),
                  }}
                />
              ))}
            </Box>
          );
        })}
        {startX > 0 && (
          <Box
            style={{
              position: "absolute",
              inset: { left: 0, top: 0 },
              width: startX,
              height: strip.height,
              background: [0, 0, 0, 150],
            }}
          />
        )}
        {endX < trackW && (
          <Box
            style={{
              position: "absolute",
              inset: { left: endX, top: 0 },
              width: trackW - endX,
              height: strip.height,
              background: [0, 0, 0, 150],
            }}
          />
        )}
      </Box>
      <Box
        style={{
          position: "absolute",
          inset: { left: startX, top: strip.y - 2 },
          width: Math.max(4, endX - startX),
          height: strip.height + 4,
          cornerRadius: 7,
          border: { width: 2, color: theme.accent },
        }}
      />
      {view.drops.map((drop) => (
        <DropMark
          key={`drop-${drop.tMs}`}
          count={drop.count}
          x={xAt(drop.tMs)}
          trackY={trackY}
          trackH={trackH}
          rem={rem}
          theme={theme}
        />
      ))}
      {(() => {
        const seen = new Set<string>();
        return view.interactions.flatMap((event) => {
          const x = xAt(event.tMs);
          const dedupe = `${event.kind}:${Math.round(x / 8)}`;
          if (seen.has(dedupe)) return [];
          seen.add(dedupe);
          return [
            <TrackIcon
              key={dedupe}
              icon={INTERACTION_ICONS[event.kind]}
              color={interactionColor(event.kind, theme)}
              label={INTERACTION_LABELS[event.kind]}
              x={x}
              trackY={trackY}
              rem={rem}
              theme={theme}
            />,
          ];
        });
      })()}
      {view.shots.map((shot) => (
        <ShotTick
          key={`shot-${shot.tMs}`}
          shot={shot}
          x={xAt(shot.tMs)}
          trackY={trackY}
          trackH={trackH}
          rem={rem}
          theme={theme}
          actions={actions}
          active={shot.tMs === view.currentKey}
          drawn={view.markers.some((marker) => marker.atMs === shot.tMs)}
        />
      ))}
      {view.markers.map((marker) => {
        const center = xAt(marker.atMs);
        const span = 4;
        return (
          <Box key={marker.atMs} style={{ position: "absolute", inset: { left: 0, top: 0 } }}>
            <Box
              style={{
                position: "absolute",
                inset: { left: center - span / 2, top: trackY - 1 },
                width: span,
                height: trackH + 2,
                cornerRadius: 2,
                background: withAlpha(theme.yellow, 180),
              }}
              onClick={() => actions.record.seek(marker.atMs)}
            />
            <TrackIcon
              icon="pen"
              color={theme.yellow}
              label="Has edits"
              x={center}
              trackY={trackY}
              rem={rem}
              theme={theme}
              onClick={() => actions.record.seek(marker.atMs)}
            />
          </Box>
        );
      })}
      <TrimHandle
        x={startX}
        strip={strip}
        rem={rem}
        theme={theme}
        onDrag={(event) => actions.record.trimDrag("start", event)}
      />
      <TrimHandle
        x={endX}
        strip={strip}
        rem={rem}
        theme={theme}
        onDrag={(event) => actions.record.trimDrag("end", event)}
      />
      <Box
        style={{
          position: "absolute",
          inset: {
            left: scrubX - Math.ceil(thumbW / 2) - 2,
            top: strip.y - 4,
          },
          width: thumbW + 4,
          height: strip.height + 8,
          alignItems: "center",
          justifyContent: "center",
        }}
        onDrag={actions.record.trackDrag}
        onMouseEnter={() => setThumbHover(true)}
        onMouseLeave={() => setThumbHover(false)}
      >
        <Box
          style={{
            width: thumbW,
            height: strip.height + 8,
            cornerRadius: thumbW / 2,
            background: view.onMarkup
              ? thumbActive
                ? mix(theme.yellow, theme.fg, 0.3)
                : theme.yellow
              : thumbActive
                ? theme.fg
                : mix(theme.fg, theme.bg, 0.08),
            border: {
              width: 1,
              color: view.onShot ? theme.accent : withAlpha(theme.overlay, 200),
            },
          }}
        />
      </Box>
      {view.scrubbing && (
        <Box
          style={{
            position: "absolute",
            inset: { left: scrubX - rem * 2.5, top: strip.y - rem * 1.45 },
            width: rem * 5,
            height: rem * 1.3,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Box
            style={{
              height: rem * 1.15,
              alignItems: "center",
              padding: { left: rem * 0.35, right: rem * 0.35 },
              cornerRadius: rem * 0.3,
              background: theme.field,
              border: { width: 1, color: theme.fieldBorder },
            }}
          >
            <Text style={{ fontSize: rem * 0.62, color: theme.fg, wrap: false, selectable: false }}>
              {formatMs(view.timeMs, withMinutes)}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}


export function ReviewToolbar({
  view,
  actions,
  layout,
  theme,
}: {
  view: RecordView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  return (
    <Box
      style={{
        height: layout.toolbarHeight,
        flexShrink: 0,
        alignItems: "center",
        gap: rem * 0.25,
        padding: { left: rem * 0.4, right: rem * 0.4 },
      }}
    >
      <Box
        style={{
          height: rem * 1.55,
          alignItems: "center",
          gap: rem * 0.3,
          padding: { left: rem * 0.55, right: rem * 0.65 },
          cornerRadius: (rem * 1.55) / 2,
          hoverBackground: theme.hover,
          flexShrink: 0,
        }}
        onClick={actions.record.discard}
      >
        <Icon icon="close" size={rem * 0.95} color={theme.muted} />
        <Text style={{ fontSize: rem * 0.68, color: theme.disabled, wrap: false, selectable: false }}>
          {view.recordKey}
        </Text>
      </Box>
      <Box
        style={{
          flexGrow: 1,
          flexBasis: 0,
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          padding: { left: rem * 0.4, right: rem * 0.4 },
          overflow: "hidden",
        }}
      >
        <Text
          style={{
            fontSize: rem * 0.82,
            color: theme.fg,
            wrap: false,
            selectable: false,
            flexShrink: 1,
            overflow: "hidden",
          }}
        >
          {displayUrl(view.pageUrl)}
        </Text>
      </Box>
      <ShotThumb view={view} rem={rem} theme={theme} />
      {view.keyframeCount > 0 && (
        <Text style={{ fontSize: rem * 0.68, color: theme.disabled, wrap: false, selectable: false }}>
          {view.keyframeCount > 1 ? "Tab to cycle" : "Tab to view"}
        </Text>
      )}
      <RecordToolbarPill view={view} actions={actions} rem={rem} theme={theme} />
    </Box>
  );
}

export function RecordToolbarPill({
  view,
  actions,
  rem,
  theme,
}: {
  view: RecordView;
  actions: ChromeActions;
  rem: number;
  theme: Theme;
}) {
  const stopped = view.stopped;
  const color = stopped ? theme.accent : theme.red;
  const height = rem * 1.55;
  return (
    <Box
      style={{
        height,
        alignItems: "center",
        gap: rem * 0.4,
        padding: { left: rem * 0.7, right: rem * 0.7 },
        margin: { left: rem * 0.3 },
        cornerRadius: height / 2,
        background: mix(color, theme.bg, 0.12),
        hoverBackground: color,
        border: { width: 1, color: [255, 255, 255, 70] },
        flexShrink: 0,
      }}
      // this makes no sense to me
      onClick={stopped ? actions.record.complete : actions.record.stop}
    >
      {!stopped && (
        <Box
          style={{
            width: rem * 0.55,
            height: rem * 0.55,
            cornerRadius: rem * 0.13,
            background: [255, 255, 255, 255],
          }}
        />
      )}
      <Text
        style={{
          fontSize: rem * 0.75,
          color: [255, 255, 255, 255],
          wrap: false,
          selectable: false,
        }}
      >
        {stopped ? "Complete" : "Stop"}
      </Text>
      <Text
        style={{
          fontSize: rem * 0.68,
          color: [255, 255, 255, 190],
          wrap: false,
          selectable: false,
        }}
      >
        {stopped ? "ctrl+enter" : view.agent ? "agent" : view.recordKey}
      </Text>
    </Box>
  );
}

export function RecordCornerButton({
  view,
  actions,
  layout,
  theme,
}: {
  view: RecordView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const right = layout.width - (layout.page.x + layout.page.width) + rem * 0.9;
  return (
    <Box style={{ position: "absolute", inset: { right, top: layout.page.y + rem * 0.9 } }}>
      <RecordToolbarPill view={view} actions={actions} rem={rem} theme={theme} />
    </Box>
  );
}
