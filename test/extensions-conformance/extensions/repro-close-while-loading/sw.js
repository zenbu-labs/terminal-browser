setTimeout(async () => {
  for (const url of ["https://example.com/", "http://10.255.255.1/never-loads", "https://example.org/", "about:blank"]) {
    const win = await chrome.windows.create({ url, type: "popup", width: 400, height: 300, focused: false });
    await chrome.windows.remove(win.id).catch(() => {});
    const tab = await chrome.tabs.create({ url, active: false });
    await chrome.tabs.remove(tab.id);
  }
}, 1500);
