chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  suggest([
    { content: `${text} one`, description: `First suggestion for ${text}` },
    { content: `${text} two`, description: `Second suggestion for ${text}` },
  ]);
});
