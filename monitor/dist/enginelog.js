"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineLog = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const KEEP_LINES = 500;
function logFile(pid) {
    const state = process.env.XDG_STATE_HOME ?? node_path_1.default.join(node_os_1.default.homedir(), ".local", "state");
    return node_path_1.default.join(state, "pixel", "logs", `${pid}.jsonl`);
}
// Follows each engine's log file from where the last poll stopped.
class EngineLog {
    offsets = new Map();
    lines = new Map();
    hasLog(pid) {
        return node_fs_1.default.existsSync(logFile(pid));
    }
    poll(pids) {
        for (const pid of pids)
            this.read(pid);
        for (const pid of [...this.lines.keys()]) {
            if (!pids.includes(pid)) {
                this.lines.delete(pid);
                this.offsets.delete(pid);
            }
        }
        return this.lines;
    }
    read(pid) {
        const file = logFile(pid);
        let size;
        try {
            size = node_fs_1.default.statSync(file).size;
        }
        catch {
            return;
        }
        const offset = this.offsets.get(pid) ?? 0;
        const start = size < offset ? 0 : offset;
        if (size === start)
            return;
        const buffer = Buffer.alloc(size - start);
        const fd = node_fs_1.default.openSync(file, "r");
        try {
            node_fs_1.default.readSync(fd, buffer, 0, buffer.length, start);
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
        const text = buffer.toString("utf8");
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline === -1)
            return;
        this.offsets.set(pid, start + Buffer.byteLength(text.slice(0, lastNewline + 1)));
        const list = this.lines.get(pid) ?? [];
        for (const line of text.slice(0, lastNewline).split("\n")) {
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (typeof parsed.message !== "string" || typeof parsed.t !== "number")
                continue;
            list.push({ at: parsed.t, level: parsed.level ?? "info", target: parsed.target ?? "", message: parsed.message });
        }
        this.lines.set(pid, list.slice(-KEEP_LINES));
    }
}
exports.EngineLog = EngineLog;
