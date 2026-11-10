export const GHOSTTY_SCRIPT = String.raw`ObjC.import("Foundation");

const Descriptor = $.NSAppleEventDescriptor;
const WAIT_FOR_REPLY = 3;
const NOT_FOUND = -1728;

function code(text) {
  return ((text.charCodeAt(0) << 24) | (text.charCodeAt(1) << 16) | (text.charCodeAt(2) << 8) | text.charCodeAt(3)) >>> 0;
}
const typeCode = (text) => Descriptor.descriptorWithTypeCode(code(text));
const enumCode = (text) => Descriptor.descriptorWithEnumCode(code(text));
const string = (text) => Descriptor.descriptorWithString(text);
const boolean = (value) => Descriptor.descriptorWithBoolean(value);
const nothing = Descriptor.nullDescriptor;
// the "every element" ordinal is the four-char code 'all ' stored in native (little-endian) byte order
const everyOrdinal = Descriptor.descriptorWithDescriptorTypeData(
  code("abso"),
  $(" lla").dataUsingEncoding($.NSMacOSRomanStringEncoding),
);

function specifier(wanted, container, form, key) {
  const record = Descriptor.recordDescriptor;
  record.setDescriptorForKeyword(typeCode(wanted), code("want"));
  record.setDescriptorForKeyword(container, code("from"));
  record.setDescriptorForKeyword(enumCode(form), code("form"));
  record.setDescriptorForKeyword(key, code("seld"));
  return record.coerceToDescriptorType(code("obj "));
}
const every = (cls, container) => specifier(cls, container, "indx", everyOrdinal);
const property = (name, of) => specifier("prop", of, "prop", typeCode(name));
const terminal = (id) => specifier("Gtrm", nothing, "ID  ", string(id));
const window = (id) => specifier("Gwnd", nothing, "ID  ", string(id));
// tabs are only reachable through their window, so a tab needs both ids
const tab = (windowId, id) => specifier("Gtab", window(windowId), "ID  ", string(id));

function unwrap(descriptor) {
  if (descriptor.isNil()) return null;
  const type = descriptor.descriptorType;
  if (type === code("list")) {
    const items = [];
    for (let i = 1; i <= descriptor.numberOfItems; i++) items.push(unwrap(descriptor.descriptorAtIndex(i)));
    return items;
  }
  if (type === code("bool") || type === code("true") || type === code("fals")) return descriptor.booleanValue;
  const text = descriptor.stringValue;
  return text.isNil() ? null : ObjC.unwrap(text);
}

function send(pid, eventClass, eventId, params) {
  const event = Descriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
    code(eventClass),
    code(eventId),
    Descriptor.descriptorWithProcessIdentifier(pid),
    -1,
    0,
  );
  for (const keyword of Object.keys(params)) event.setParamDescriptorForKeyword(params[keyword], code(keyword));
  const failure = Ref();
  const reply = event.sendEventWithOptionsTimeoutError(WAIT_FOR_REPLY, 10, failure);
  if (reply.isNil()) {
    throw new Error("Ghostty (pid " + pid + ") did not answer: " + ObjC.unwrap(failure[0].localizedDescription) );
  }
  const number = reply.paramDescriptorForKeyword(code("errn"));
  if (!number.isNil()) {
    const message = reply.paramDescriptorForKeyword(code("errs"));
    const detail = message.isNil() ? "" : ": " + ObjC.unwrap(message.stringValue);
    const error = new Error("Ghostty (pid " + pid + ") refused the request (" + number.int32Value + ")" + detail );
    error.code = number.int32Value;
    throw error;
  }
  return reply.paramDescriptorForKeyword(code("----"));
}

const get = (pid, name, of) => unwrap(send(pid, "core", "getd", { "----": property(name, of) }));
const performAction = (pid, action, on) => unwrap(send(pid, "Ghst", "PfAc", { "----": string(action), GonT: on }));

function list(pid) {
  const windows = every("Gwnd", nothing);
  const tabs = every("Gtab", windows);
  const terminals = every("Gtrm", tabs);
  const optional = (name) => {
    try {
      return get(pid, name, terminals);
    } catch (error) {
      if (error.code === NOT_FOUND) return null;
      throw error;
    }
  };
  const windowIds = get(pid, "ID  ", windows);
  const tabIds = get(pid, "ID  ", tabs);
  const ids = get(pid, "ID  ", terminals);
  const cwds = get(pid, "Gwdr", terminals);
  const foregroundPids = optional("Gpid");
  const ttys = optional("Gtty");
  let out = "";
  windowIds.forEach((windowId, w) => {
    tabIds[w].forEach((tabId, t) => {
      ids[w][t].forEach((id, i) => {
        const foreground = foregroundPids ? foregroundPids[w][t][i] : "";
        const tty = ttys ? ttys[w][t][i] : "";
        out += [windowId, tabId, id, foreground ?? "", tty ?? "", cwds[w][t][i] ?? ""].join("\t") + "\n";
      });
    });
  });
  return out;
}

// Ghostty does not report where splits sit, but goto_split says whether it could
// move and the tab says where focus landed. Focus moves a moment after each
// action returns, so every move is waited for; focus is put back where it was.
function neighbor(pid, windowId, tabId, id, direction) {
  const inTab = tab(windowId, tabId);
  const focused = () => get(pid, "ID  ", property("GTfT", inTab));
  const settle = (until) => {
    for (let i = 0; i < 50; i++) {
      const now = focused();
      if (until(now)) return now;
      delay(0.02);
    }
    return focused();
  };
  const focus = (target) => {
    send(pid, "Ghst", "Fcus", { "----": terminal(target) });
    settle((now) => now === target);
  };
  const startId = focused();
  if (startId !== id) focus(id);
  const moved = performAction(pid, "goto_split:" + direction, terminal(id)) === true;
  const endId = moved ? settle((now) => now !== id) : id;
  if (focused() !== startId) focus(startId);
  return moved && endId !== id ? endId : "";
}

function orNotFound(work) {
  try {
    return work();
  } catch (error) {
    if (error.code === NOT_FOUND) return "not-found";
    throw error;
  }
}

function run(argv) {
  const [pid, command, ...rest] = argv;
  const target = Number(pid);
  switch (command) {
    case "list":
      return list(target);
    case "split":
      return orNotFound(() => {
        const [id, direction, directory, command] = rest;
        const configuration = Descriptor.recordDescriptor;
        configuration.setDescriptorForKeyword(string(directory), code("GScD"));
        configuration.setDescriptorForKeyword(string(command), code("GScC"));
        configuration.setDescriptorForKeyword(boolean(false), code("GScW"));
        const opened = send(target, "Ghst", "Splt", { "----": terminal(id), GSpd: enumCode(direction), GSpS: configuration });
        return get(target, "ID  ", opened);
      });
    case "input":
      return orNotFound(() => {
        send(target, "Ghst", "InTx", { "----": string(rest[1]), GItT: terminal(rest[0]) });
        return "ok";
      });
    case "focus":
      return orNotFound(() => {
        send(target, "Ghst", "Fcus", { "----": terminal(rest[0]) });
        return "ok";
      });
    case "action":
      return orNotFound(() => String(performAction(target, rest[1], terminal(rest[0]))));
    case "neighbor":
      return orNotFound(() => neighbor(target, rest[0], rest[1], rest[2], rest[3]));
  }
  throw new Error("unknown command " + command);
}
`;
