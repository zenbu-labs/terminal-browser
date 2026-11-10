"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERIES = void 0;
exports.loadRecordings = loadRecordings;
exports.saveRecording = saveRecording;
exports.deleteRecording = deleteRecording;
exports.newRecording = newRecording;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
exports.SERIES = ["terminal", "total", "engine", "gpu"];
function dir() {
    const state = process.env.XDG_STATE_HOME ?? node_path_1.default.join(node_os_1.default.homedir(), ".local", "state");
    return node_path_1.default.join(state, "terminal-browser", "monitor");
}
function loadRecordings() {
    let names = [];
    try {
        names = node_fs_1.default.readdirSync(dir()).filter((name) => name.endsWith(".json"));
    }
    catch {
        return [];
    }
    const recordings = [];
    for (const name of names) {
        try {
            const parsed = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(dir(), name), "utf8"));
            if (Array.isArray(parsed.points) && typeof parsed.startedAt === "number")
                recordings.push(parsed);
        }
        catch { }
    }
    return recordings.sort((a, b) => a.startedAt - b.startedAt);
}
function saveRecording(recording) {
    node_fs_1.default.mkdirSync(dir(), { recursive: true });
    const file = node_path_1.default.join(dir(), `${recording.id}.json`);
    node_fs_1.default.writeFileSync(file, JSON.stringify(recording));
    return file;
}
function deleteRecording(id) {
    try {
        node_fs_1.default.unlinkSync(node_path_1.default.join(dir(), `${id}.json`));
    }
    catch { }
}
function newRecording(browser) {
    const startedAt = Date.now();
    const stamp = new Date(startedAt);
    const name = `${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}:${String(stamp.getSeconds()).padStart(2, "0")} ${browser}`;
    return { id: String(startedAt), name, browser, startedAt, points: [] };
}
