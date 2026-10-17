
(() => {
  const input = document.getElementById("search-input");
  const list = document.getElementById("search-suggest");
  const form = document.getElementById("search-form");
  const searchTemplate = input?.dataset?.searchTemplate ?? "";
  const suggestTemplate = input?.dataset?.suggestTemplate || null;
  const hasAuthority = /^[a-z][a-z0-9+.-]*:\/\//i;
  const noHost = /^(?:data|mailto|tel|about|blob|chrome|view-source):/i;
  const hostPortPath = /^[\w.-]+(?::\d+)?(?:\/.*)?$/;
  const hostColonPort = /^[\w-]+:\d+(\/.*)?$/;
  const substitute = (template, query) => {
    const encoded = encodeURIComponent(query);
    return template.includes("%s") ? template.split("%s").join(encoded) : template + encoded;
  };
  const resolve = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return "about:blank";
    if (hasAuthority.test(trimmed) || noHost.test(trimmed)) {
      try { return new URL(trimmed).toString(); } catch {}
    } else if ((!trimmed.includes(" ") && trimmed.includes(".")) || hostColonPort.test(trimmed)) {
      if (hostPortPath.test(trimmed)) {
        const host = trimmed.split(/[:/]/)[0].toLowerCase();
        const scheme = host === "localhost" || host === "127.0.0.1" ? "http" : "https";
        try { return new URL(scheme + "://" + trimmed).toString(); } catch {}
      }
    }
    return substitute(searchTemplate, trimmed);
  };
  const go = (value, newTab) => {
    const url = resolve(value);
    if (newTab) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } else {
      location.href = url;
    }
  };
  const parse = (body) => {
    try {
      const data = JSON.parse(body);
      if (Array.isArray(data) && Array.isArray(data[1])) return data[1].filter((s) => typeof s === "string");
      if (data && Array.isArray(data.suggestions)) return data.suggestions.filter((s) => typeof s === "string");
    } catch {}
    return [];
  };
  let items = [];
  let active = -1;
  let seq = 0;
  let timer = 0;
  let aborter = null;
  const apiBase = (() => {
    const root = location.origin + location.pathname;
    return root.endsWith("/") ? root.slice(0, -1) : root;
  })();
  const suggestIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  suggestIcon.setAttribute("viewBox", "0 0 16 16");
  suggestIcon.setAttribute("aria-hidden", "true");
  suggestIcon.innerHTML = '<circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.7 10.7 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
  const hide = () => {
    if (!list) return;
    items = [];
    active = -1;
    list.hidden = true;
    list.replaceChildren();
  };
  const show = () => {
    if (!list) return;
    list.replaceChildren();
    items.forEach((text, index) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = text;
      row.append(suggestIcon.cloneNode(true), label);
      row.setAttribute("role", "option");
      if (index === active) row.setAttribute("aria-selected", "true");
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        hide();
        go(text, event.altKey);
      });
      list.appendChild(row);
      if (index === active) {
        const bottom = row.offsetTop + row.offsetHeight;
        if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
        else if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
      }
    });
    list.hidden = items.length === 0;
  };
  if (input) {
  input.addEventListener("input", () => {
    active = -1;
    clearTimeout(timer);
    if (aborter) aborter.abort();
    const query = input.value.trim();
    if (!suggestTemplate || !query) {
      hide();
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        aborter = new AbortController();
        const response = await fetch(apiBase + "/api/suggest?q=" + encodeURIComponent(query), {
          signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(3000)]),
        });
        if (!response.ok || mine !== seq) return;
        items = parse(await response.text()).slice(0, 8);
        active = -1;
        show();
      } catch {}
    }, 150);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!list || list.hidden || items.length === 0) return;
      event.preventDefault();
      active = event.key === "ArrowDown"
        ? (active + 1) % items.length
        : (active - 1 + items.length) % items.length;
      show();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const pick = active >= 0 && items[active] !== undefined ? items[active] : input.value;
      hide();
      go(pick, event.altKey);
    } else if (event.key === "Escape") {
      hide();
    }
  });
  }
  if (form && input) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    go(input.value, false);
  });
  }
  document.addEventListener("keydown", (event) => {
    if (!input) return;
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (target instanceof HTMLElement && target.isContentEditable) return;
    if (document.activeElement === input) return;
    event.preventDefault();
    input.focus();
  });
  // dev servers come and go: refresh only when the lists changed, and never
  // steal typed input, focus, or scroll position to do it
  const data = () => fetch(location.origin + location.pathname + "?data").then(r => r.ok ? r.text() : null).catch(() => null);
  // Home has no dynamic sections: skip the baseline fetch and the poller there.
  const hasDevSections = () => document.querySelector("section, .empty") !== null;
  if (!hasDevSections()) return;
  data().then(t => { window.__start = t; });
  try {
    const saved = JSON.parse(sessionStorage.getItem("terminal-browser:start-scroll") || "null");
    if (Array.isArray(saved)) scrollTo(saved[0] || 0, saved[1] || 0);
    sessionStorage.removeItem("terminal-browser:start-scroll");
  } catch {}
  const searchBusy = () => !!input && (document.activeElement === input || input.value !== "");
  const reloadSoon = () => {
    try { sessionStorage.setItem("terminal-browser:start-scroll", JSON.stringify([scrollX, scrollY])); } catch {}
    location.reload();
  };
  let pending = false;
  const maybeReload = () => {
    if (!pending || searchBusy()) return;
    pending = false;
    reloadSoon();
  };
  input?.addEventListener("input", maybeReload);
  input?.addEventListener("blur", maybeReload);
  setInterval(async () => {
    const fresh = await data();
    if (!fresh || fresh === window.__start) return;
    window.__start = fresh;
    if (searchBusy()) {
      pending = true;
      return;
    }
    reloadSoon();
  }, 8000);
})();
