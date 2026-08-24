const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  listSearchEngines,
  renderSearchTemplate,
  searchEngine,
  searchEngineFromTemplate,
} = require("../dist/search-engines");

test("provides the supported search engine catalog", () => {
  assert.deepEqual(
    listSearchEngines().map((engine) => engine.id),
    ["brave", "google", "duckduckgo", "bing", "kagi", "startpage", "ecosia"],
  );
  assert.equal(searchEngine("BRAVE").name, "Brave Search");
  assert.equal(searchEngine("unknown"), null);
});

test("renders queries and recognizes imported providers", () => {
  assert.equal(
    renderSearchTemplate(searchEngine("brave").searchUrl, "terminal browser"),
    "https://search.brave.com/search?q=terminal%20browser",
  );
  assert.equal(
    searchEngineFromTemplate("Imported", "https://duckduckgo.com/?q={searchTerms}").id,
    "duckduckgo",
  );
  assert.deepEqual(
    searchEngineFromTemplate("Example Search", "https://search.example.test/?q={searchTerms}"),
    {
      id: "custom",
      name: "Example Search",
      searchUrl: "https://search.example.test/?q={searchTerms}",
    },
  );
});
