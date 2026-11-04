const out = document.getElementById("gesture-out");
const show = (key, value) => {
  out.dataset[key] = value;
  out.textContent += `${key}: ${value}\n`;
};

document.getElementById("open-panel").addEventListener("click", async () => {
  const win = await chrome.windows.getCurrent();
  chrome.sidePanel.open({ windowId: win.id }).then(() => show("panel", "opened"), (e) => show("panel", `rejects: ${e.message}`));
});

document.getElementById("request-permission").addEventListener("click", () => {
  chrome.permissions.request({ origins: ["https://optional.test/*"] }).then((granted) => show("request", `granted=${granted}`), (e) => show("request", `rejects: ${e.message}`));
});
