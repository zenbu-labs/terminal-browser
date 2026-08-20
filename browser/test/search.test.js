const assert = require("node:assert/strict");
const { test } = require("node:test");

const { fetchSuggestions } = require("../dist/session/suggest");
const { searchOrUrl } = require("../dist/url");

const brave = {
  id: "brave",
  name: "Brave Search",
  searchUrl: "https://search.brave.com/search?q={searchTerms}",
  suggestUrl: "https://search.brave.com/api/suggest?q={searchTerms}",
};

test("routes search text through the selected provider", () => {
  assert.equal(
    searchOrUrl("terminal browser", undefined, brave),
    "https://search.brave.com/search?q=terminal%20browser",
  );
  assert.equal(searchOrUrl("example.com", undefined, brave), "example.com");
});

test("uses the selected provider for suggestions", async () => {
  const original = global.fetch;
  let requested = "";
  global.fetch = async (url) => {
    requested = String(url);
    return { text: async () => JSON.stringify(["terminal", ["terminal browser"]]) };
  };
  try {
    assert.deepEqual(await fetchSuggestions("terminal browser", brave), ["terminal browser"]);
    assert.equal(
      requested,
      "https://search.brave.com/api/suggest?q=terminal%20browser",
    );
  } finally {
    global.fetch = original;
  }
});

test("does not request suggestions when the provider has no endpoint", async () => {
  assert.deepEqual(
    await fetchSuggestions("terminal", {
      id: "kagi",
      name: "Kagi",
      searchUrl: "https://kagi.com/search?q={searchTerms}",
    }),
    [],
  );
});
