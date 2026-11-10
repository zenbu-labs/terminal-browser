"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEFT_GUTTER = void 0;
exports.niceMax = niceMax;
exports.seriesMax = seriesMax;
exports.Chart = Chart;
const jsx_runtime_1 = require("react/jsx-runtime");
const pixel_1 = require("@zenbu-labs/pixel");
exports.LEFT_GUTTER = 3.2;
const BOTTOM_GUTTER = 1.4;
function niceMax(value) {
    const floor = 10;
    if (value <= floor)
        return floor;
    const steps = [20, 25, 40, 50, 75, 100, 150, 200, 300, 400, 600, 800];
    for (const step of steps)
        if (value <= step)
            return step;
    return Math.ceil(value / 100) * 100;
}
function seriesMax(lines) {
    let max = 0;
    for (const line of lines) {
        for (const point of line.points)
            max = Math.max(max, point.values[line.series]);
    }
    return niceMax(max * 1.1);
}
function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}
function Chart({ width, height, windowSeconds, lines, hover, onHover, rem, theme }) {
    const left = rem * exports.LEFT_GUTTER;
    const bottom = rem * BOTTOM_GUTTER;
    const plotW = Math.max(1, width - left - rem * 0.5);
    const plotH = Math.max(1, height - bottom - rem * 0.5);
    const top = rem * 0.5;
    const yMax = seriesMax(lines);
    const x = (t) => left + (Math.min(Math.max(t, 0), windowSeconds) / windowSeconds) * plotW;
    const y = (v) => top + plotH - (Math.min(v, yMax) / yMax) * plotH;
    const gridSteps = yMax <= 20 ? 4 : 5;
    const gridValues = Array.from({ length: gridSteps + 1 }, (_, i) => (yMax / gridSteps) * i);
    const tickEvery = windowSeconds <= 60 ? 15 : windowSeconds <= 180 ? 30 : 60;
    const ticks = Array.from({ length: Math.floor(windowSeconds / tickEvery) + 1 }, (_, i) => i * tickEvery);
    return ((0, jsx_runtime_1.jsxs)(pixel_1.Box, { style: { width, height, position: "flow", flexShrink: 0 }, onMouseMove: (event) => {
            const t = ((event.x - left) / plotW) * windowSeconds;
            onHover(t >= 0 && t <= windowSeconds ? t : null);
        }, onMouseLeave: () => onHover(null), children: [gridValues.map((value) => ((0, jsx_runtime_1.jsx)(pixel_1.Box, { style: {
                    position: "absolute",
                    inset: { left, top: y(value) },
                    width: plotW,
                    height: 1,
                    background: value === 0 ? theme.muted : theme.hairline,
                } }, `grid-${value}`))), gridValues.map((value) => ((0, jsx_runtime_1.jsx)(pixel_1.Text, { style: {
                    position: "absolute",
                    inset: { left: 0, top: y(value) - rem * 0.45 },
                    width: left - rem * 0.4,
                    fontSize: rem * 0.62,
                    color: theme.muted,
                    wrap: false,
                    selectable: false,
                }, children: `${Math.round(value)}%`.padStart(4) }, `label-${value}`))), ticks.map((tick) => ((0, jsx_runtime_1.jsx)(pixel_1.Text, { style: {
                    position: "absolute",
                    inset: { left: x(tick) - rem * 0.8, top: top + plotH + rem * 0.2 },
                    width: rem * 1.6,
                    fontSize: rem * 0.6,
                    color: theme.muted,
                    wrap: false,
                    selectable: false,
                }, children: tick === 0 ? "0s" : `${tick}s` }, `tick-${tick}`))), lines.map((line) => {
                const d = line.points
                    .map((point, i) => `${i === 0 ? "M" : "L"}${x(point.t).toFixed(1)} ${y(point.values[line.series]).toFixed(1)}`)
                    .join(" ");
                if (line.points.length < 2)
                    return null;
                return ((0, jsx_runtime_1.jsx)(pixel_1.Path, { d: d, stroke: {
                        width: line.overlay ? 1.5 : 2,
                        color: hexToRgba(line.color, line.overlay ? 120 : 255),
                        cap: "round",
                        join: "round",
                    }, style: { position: "absolute", inset: { left: 0, top: 0 }, width, height } }, line.key));
            }), hover != null && ((0, jsx_runtime_1.jsx)(pixel_1.Box, { style: {
                    position: "absolute",
                    inset: { left: x(hover), top },
                    width: 1,
                    height: plotH,
                    background: theme.fg,
                } }))] }));
}
