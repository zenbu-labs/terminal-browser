setTimeout(() => chrome.system.storage.getInfo().then((units) => console.log("units", units.length)), 1000);
