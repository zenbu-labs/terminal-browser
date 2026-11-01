// system.*, settings-style APIs, capture, tts, gcm/instanceID, newer and channel-gated namespaces
(() => {
  const { test } = god;
  const pageTab = async () => (await chrome.tabs.query({ url: "http://localhost/*" }))[0];

  test("system.cpu.getInfo", async (t) => {
    const i = await chrome.system.cpu.getInfo();
    t.shape(i, { numOfProcessors: "number", archName: "string", modelName: "string", features: "array", processors: "array", temperatures: "array" });
    t.shape(i.processors[0].usage, { user: "number", kernel: "number", idle: "number", total: "number" });
    return t.keys(i);
  });

  test("system.memory.getInfo", async (t) => {
    const i = await chrome.system.memory.getInfo();
    t.shape(i, { capacity: "number", availableCapacity: "number" });
  });

  test("system.storage.getInfo", async (t) => {
    const units = await chrome.system.storage.getInfo();
    t.type(units, "array");
    if (units[0]) t.shape(units[0], { id: "string", name: "string", type: "string", capacity: "number" });
    return "array";
  });

  test("system.storage.getAvailableCapacity", async (t) => t.rejects(chrome.system.storage.getAvailableCapacity("not-a-device")));
  test("system.storage.ejectDevice", async (t) => `${await chrome.system.storage.ejectDevice("not-a-device")}`);
  test("system.storage.events", (t) => t.ok(chrome.system.storage.onAttached.addListener && chrome.system.storage.onDetached.addListener));

  test("system.display.getInfo", async (t) => {
    const d = await chrome.system.display.getInfo();
    t.type(d, "array");
    t.ok(d.length >= 1, "no displays");
    t.shape(d[0], { id: "string", name: "string", isPrimary: "boolean", isInternal: "boolean", isEnabled: "boolean", dpiX: "number", dpiY: "number", rotation: "number", bounds: "object", workArea: "object", overscan: "object" });
    return t.keys(d[0]);
  });

  test("system.display.getDisplayLayout", (t) => t.outcome(chrome.system.display.getDisplayLayout()));

  for (const fn of ["setDisplayProperties", "setDisplayLayout", "enableUnifiedDesktop", "overscanCalibrationStart", "overscanCalibrationAdjust", "overscanCalibrationReset", "overscanCalibrationComplete", "showNativeTouchCalibration", "startCustomTouchCalibration", "completeCustomTouchCalibration", "clearTouchCalibration", "setMirrorMode"]) {
    test(`system.display.${fn}`, async (t) => {
      const args = { setDisplayProperties: ["x", {}], setDisplayLayout: [[]], enableUnifiedDesktop: [false], overscanCalibrationStart: ["x"], overscanCalibrationAdjust: ["x", { left: 0, top: 0, right: 0, bottom: 0 }], overscanCalibrationReset: ["x"], overscanCalibrationComplete: ["x"], showNativeTouchCalibration: ["x"], startCustomTouchCalibration: ["x"], completeCustomTouchCalibration: [{ pair1: {}, pair2: {}, pair3: {}, pair4: {} }, { left: 0, top: 0, width: 1, height: 1 }], clearTouchCalibration: ["x"], setMirrorMode: [{ mode: "off" }] }[fn];
      try {
        const r = await chrome.system.display[fn](...args);
        return `resolved ${godJson(r)}`;
      } catch (error) {
        return `rejects/throws: ${String(error.message).slice(0, 80)}`;
      }
    });
  }

  test("system.display.onDisplayChanged", (t) => t.ok(chrome.system.display.onDisplayChanged.addListener));

  const settingProbe = async (t, setting) => {
    const v = await setting.get({});
    t.shape(v, { value: "any", levelOfControl: "string" });
    return `value=${godJson(v.value)} level=${v.levelOfControl}`;
  };

  test("privacy.network.networkPredictionEnabled", (t) => settingProbe(t, chrome.privacy.network.networkPredictionEnabled));
  test("privacy.network.webRTCIPHandlingPolicy#set", async (t) => {
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
    t.eq((await chrome.privacy.network.webRTCIPHandlingPolicy.get({})).value, "disable_non_proxied_udp");
    await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
  });
  test("privacy.services.passwordSavingEnabled", (t) => settingProbe(t, chrome.privacy.services.passwordSavingEnabled));
  test("privacy.websites.doNotTrackEnabled", (t) => settingProbe(t, chrome.privacy.websites.doNotTrackEnabled));
  test("privacy.websites.thirdPartyCookiesAllowed", (t) => settingProbe(t, chrome.privacy.websites.thirdPartyCookiesAllowed));
  test("privacy.onChange", async (t) => {
    await t.event(chrome.privacy.websites.doNotTrackEnabled.onChange, () => chrome.privacy.websites.doNotTrackEnabled.set({ value: true }));
    await chrome.privacy.websites.doNotTrackEnabled.clear({});
  });

  test("accessibilityFeatures.animationPolicy", (t) => settingProbe(t, chrome.accessibilityFeatures.animationPolicy));

  test("contentSettings.javascript.get/set/clear", async (t, c) => {
    const url = `${c.site}/`;
    t.eq((await chrome.contentSettings.javascript.get({ primaryUrl: url })).setting, "allow");
    await chrome.contentSettings.javascript.set({ primaryPattern: "http://localhost/*", setting: "block" });
    t.eq((await chrome.contentSettings.javascript.get({ primaryUrl: url })).setting, "block");
    await chrome.contentSettings.javascript.clear({});
    t.eq((await chrome.contentSettings.javascript.get({ primaryUrl: url })).setting, "allow");
  });
  test("contentSettings.cookies.getResourceIdentifiers", async (t) => `${godJson(await chrome.contentSettings.cookies.getResourceIdentifiers())}`);

  test("fontSettings.getFontList", async (t) => {
    const fonts = await chrome.fontSettings.getFontList();
    t.ok(fonts.length > 0, "no fonts");
    t.shape(fonts[0], { fontId: "string", displayName: "string" });
  });
  test("fontSettings.getDefaultFontSize/set/clear", async (t) => {
    const d = await chrome.fontSettings.getDefaultFontSize({});
    t.shape(d, { pixelSize: "number", levelOfControl: "string" });
    await chrome.fontSettings.setDefaultFontSize({ pixelSize: 20 });
    t.eq((await chrome.fontSettings.getDefaultFontSize({})).pixelSize, 20);
    await chrome.fontSettings.clearDefaultFontSize({});
  });
  test("fontSettings.getFont", async (t) => godJson(Object.keys(await chrome.fontSettings.getFont({ genericFamily: "standard" })).sort()));

  test("tts.getVoices", async (t) => {
    const voices = await chrome.tts.getVoices();
    t.type(voices, "array");
    return `count>0=${voices.length > 0} god=${voices.some((v) => v.voiceName === "God Voice")}`;
  });
  test("tts.isSpeaking", async (t) => `${await chrome.tts.isSpeaking()}`);
  test("tts.speak+ttsEngine.onSpeak", async (t) => {
    const fn = (utterance, options, send) => send({ type: "end", charIndex: utterance.length });
    chrome.ttsEngine.onSpeak.addListener(fn);
    try {
      const [ev] = await new Promise((resolve, reject) => {
        chrome.tts.speak("god", { voiceName: "God Voice", volume: 0, onEvent: (e) => (e.type === "end" || e.type === "error") && resolve([e]) });
        setTimeout(() => reject(new Error("no tts event")), 5000);
      });
      t.eq(ev.type, "end");
    } finally {
      chrome.ttsEngine.onSpeak.removeListener(fn);
    }
  });
  test("tts.stop/pause/resume", (t) => {
    chrome.tts.stop();
    chrome.tts.pause();
    chrome.tts.resume();
  });
  test("ttsEngine.updateVoices", async (t) => {
    chrome.ttsEngine.updateVoices([{ voiceName: "God Voice", lang: "en-US", eventTypes: ["start", "end"] }]);
  });

  test("pageCapture.saveAsMHTML", async (t) => {
    const tab = await pageTab();
    const blob = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id });
    t.ok(blob && blob.size > 100, "empty");
  });

  test("tabCapture.getMediaStreamId", async (t) => {
    const tab = await pageTab();
    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }).catch((e) => `rejects: ${e.message}`);
    return typeof id === "string" && !id.startsWith("rejects") ? "stream id" : id;
  });
  test("tabCapture.getCapturedTabs", async (t) => godJson(await chrome.tabCapture.getCapturedTabs()));

  test("desktopCapture.chooseDesktopMedia/cancel", (t) => {
    const id = chrome.desktopCapture.chooseDesktopMedia(["screen"], () => {});
    t.type(id, "number");
    chrome.desktopCapture.cancelChooseDesktopMedia(id);
  });

  test("gcm.MAX_MESSAGE_SIZE", () => `${chrome.gcm.MAX_MESSAGE_SIZE}`);
  test("gcm.register", (t) => t.outcome(chrome.gcm.register(["not-a-sender"]), 5000));
  test("instanceID.getID", async (t) => {
    const id = await chrome.instanceID.getID();
    t.type(id, "string");
  }, { timeout: 15000 });
  test("instanceID.getCreationTime", async (t) => `${typeof (await chrome.instanceID.getCreationTime())}`, { timeout: 15000 });

  test("webAuthenticationProxy.attach/detach", async (t) => {
    const r = await chrome.webAuthenticationProxy.attach().then((x) => `attach=${x ?? "ok"}`, (e) => `rejects: ${e.message}`);
    await chrome.webAuthenticationProxy.detach().catch(() => {});
    return r;
  });

  test("printerProvider.events", (t) => t.ok(chrome.printerProvider.onGetPrintersRequested.addListener && chrome.printerProvider.onPrintRequested.addListener));

  test("publicSuffix.getDomain", async (t) => {
    const r = await chrome.publicSuffix.getDomain("a.b.example.co.uk");
    return godJson(r);
  });

  test("dns.resolve#dev-channel", async (t) => {
    if (!chrome.dns) return "absent";
    const r = await chrome.dns.resolve("localhost");
    return `resultCode=${r.resultCode}`;
  });

  test("processes#dev-channel", async (t) => {
    if (!chrome.processes) return "absent";
    const tab = await pageTab();
    return `pid=${typeof (await chrome.processes.getProcessIdForTab(tab.id))}`;
  });

  test("dom.openOrClosedShadowRoot", (t) => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    t.eq(host.shadowRoot, null);
    t.eq(chrome.dom.openOrClosedShadowRoot(host), root);
  }, { ctx: ["cs"] });

  test("dom#absent-in-sw", (t) => (chrome.dom ? "present" : "absent"));
})();
