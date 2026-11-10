"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Sampler = void 0;
exports.findTerminal = findTerminal;
const node_child_process_1 = require("node:child_process");
const node_events_1 = require("node:events");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const terminal_1 = require("@zenbu-labs/pixel/terminal");
const REFRESH_INSTANCES_MS = 5000;
const TERMINAL_NAMES = /ghostty|forky|kitty|wezterm|iterm/i;
function ps(args) {
    return (0, node_child_process_1.spawnSync)("ps", args, { encoding: "utf8" }).stdout?.trim() ?? "";
}
function psAsync(args) {
    return new Promise((resolve) => {
        (0, node_child_process_1.execFile)("ps", args, { encoding: "utf8" }, (_error, stdout) => resolve((stdout ?? "").trim()));
    });
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function findTerminal() {
    let pid = process.ppid;
    for (let i = 0; i < 16 && pid > 1; i++) {
        const [ppid, ...comm] = ps(["-o", "ppid=,comm=", "-p", String(pid)]).split(/\s+/);
        const name = comm.join(" ");
        if (TERMINAL_NAMES.test(name)) {
            const app = name.match(/\/([^/]+)\.app\//)?.[1] ?? node_path_1.default.basename(name);
            return { pid, app };
        }
        pid = Number(ppid);
        if (!Number.isFinite(pid))
            break;
    }
    return null;
}
function readRegistry() {
    const state = process.env.XDG_STATE_HOME ?? node_path_1.default.join(node_os_1.default.homedir(), ".local", "state");
    const dir = node_path_1.default.join(state, "pixel", "instances");
    let names = [];
    try {
        names = node_fs_1.default.readdirSync(dir).filter((name) => name.endsWith(".json"));
    }
    catch {
        return [];
    }
    const found = [];
    for (const name of names) {
        try {
            const parsed = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(dir, name), "utf8"));
            if (typeof parsed.pid === "number" && parsed.name === "terminal-browser" && alive(parsed.pid)) {
                found.push({ pid: parsed.pid, tty: typeof parsed.tty === "string" ? node_path_1.default.basename(parsed.tty) : null });
            }
        }
        catch { }
    }
    return found;
}
function buildLabel(args) {
    const main = args.match(/(\S+)\/browser\/dist\/main\.js/)?.[1];
    if (!main)
        return "browser";
    if (/\.local\/share\/terminal-browser|Caskroom|\/Applications\//.test(main))
        return "installed";
    return node_path_1.default.basename(main);
}
function helperKind(args) {
    const type = args.match(/--type=([a-z-]+)/)?.[1];
    if (type === "gpu-process")
        return "gpu";
    if (type === "renderer")
        return "renderer";
    return type ?? "helper";
}
// A browser is launched detached and ends up parented to launchd, so its pane's shell is
// what still leads back to the terminal that owns it.
async function terminalOwningTtys() {
    const processes = new Map();
    for (const line of (await psAsync(["-axo", "pid=,ppid=,tty=,comm="])).split("\n")) {
        const parts = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (parts)
            processes.set(Number(parts[1]), { parent: Number(parts[2]), tty: parts[3], name: parts[4] });
    }
    const owners = new Map();
    for (const [pid, { tty }] of processes) {
        if (tty.startsWith("?") || owners.has(tty))
            continue;
        for (let at = pid, hops = 0; hops < 32 && processes.has(at); hops++) {
            const { parent, name } = processes.get(at);
            if (TERMINAL_NAMES.test(name)) {
                owners.set(tty, at);
                break;
            }
            at = parent;
        }
    }
    return owners;
}
// The ttys sharing this pane's terminal tab, or null when the terminal cannot say.
async function ttysInOwnTab(driver, ownTty) {
    if (!driver?.listPanes || !ownTty)
        return null;
    try {
        const panes = await driver.listPanes({ tty: ownTty });
        const own = panes.find((pane) => pane.tty === ownTty);
        if (!own)
            return null;
        return new Set(panes
            .filter((pane) => pane.tab === own.tab && pane.tty)
            .map((pane) => node_path_1.default.basename(pane.tty)));
    }
    catch {
        return null;
    }
}
async function describeInstances(terminal, driver, ownTty) {
    const instances = [];
    const inTab = await ttysInOwnTab(driver, ownTty);
    const owners = inTab || !terminal ? null : await terminalOwningTtys();
    for (const { pid, tty } of readRegistry()) {
        if (inTab && (!tty || !inTab.has(tty)))
            continue;
        if (owners && (!tty || owners.get(tty) !== terminal.pid))
            continue;
        const args = await psAsync(["-o", "args=", "-p", String(pid)]);
        const childList = await new Promise((resolve) => {
            (0, node_child_process_1.execFile)("pgrep", ["-P", String(pid)], { encoding: "utf8" }, (_error, stdout) => resolve((stdout ?? "")
                .split("\n")
                .map(Number)
                .filter((n) => n > 0)));
        });
        const helpers = [];
        for (const child of childList) {
            helpers.push({ pid: child, kind: helperKind(await psAsync(["-o", "args=", "-p", String(child)])) });
        }
        instances.push({ pid, label: buildLabel(args), tty, helpers });
    }
    return instances.sort((a, b) => a.pid - b.pid);
}
/// Streams one CPU sample per second from `top`, attributing helper processes to the
/// browser that owns them. `top -l 0` runs continuously so nothing blocks the UI.
class Sampler extends node_events_1.EventEmitter {
    terminal;
    top = null;
    buffer = "";
    instances = [];
    refreshedAt = 0;
    first = true;
    driver = (0, terminal_1.detect)(process.env);
    ownTty = process.env.PIXEL_TTY ?? (0, terminal_1.callerTty)().path ?? null;
    constructor(terminal) {
        super();
        this.terminal = terminal;
    }
    start() {
        void this.refresh();
        this.top = (0, node_child_process_1.spawn)("top", ["-l", "0", "-s", "1", "-stats", "pid,cpu"], { stdio: ["ignore", "pipe", "ignore"] });
        this.top.stdout?.setEncoding("utf8");
        this.top.stdout?.on("data", (chunk) => {
            this.buffer += chunk;
            let at = this.buffer.indexOf("\nProcesses:", 1);
            while (at !== -1) {
                const block = this.buffer.slice(0, at);
                this.buffer = this.buffer.slice(at + 1);
                this.consume(block);
                at = this.buffer.indexOf("\nProcesses:", 1);
            }
        });
        this.top.on("exit", () => this.emit("exit"));
    }
    stop() {
        this.top?.kill();
        this.top = null;
    }
    async refresh() {
        this.refreshedAt = Date.now();
        this.instances = await describeInstances(this.terminal, this.driver, this.ownTty);
    }
    consume(block) {
        if (this.first) {
            this.first = false;
            return;
        }
        if (Date.now() - this.refreshedAt > REFRESH_INSTANCES_MS)
            void this.refresh();
        const cpu = new Map();
        for (const line of block.split("\n")) {
            const m = line.match(/^\s*(\d+)\s+([\d.]+)/);
            if (m)
                cpu.set(Number(m[1]), Number(m[2]));
        }
        const at = Date.now();
        const browsers = this.instances.map((instance) => {
            const engine = cpu.get(instance.pid) ?? 0;
            let gpu = 0;
            let renderer = 0;
            let total = engine;
            for (const helper of instance.helpers) {
                const value = cpu.get(helper.pid) ?? 0;
                total += value;
                if (helper.kind === "gpu")
                    gpu += value;
                else if (helper.kind === "renderer")
                    renderer += value;
            }
            return { pid: instance.pid, label: instance.label, tty: instance.tty, total, engine, gpu, renderer };
        });
        const sample = {
            at,
            terminal: this.terminal ? cpu.get(this.terminal.pid) ?? 0 : 0,
            browsers,
        };
        this.emit("sample", sample);
    }
}
exports.Sampler = Sampler;
