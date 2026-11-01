window.godMainMarker = "main";
document.documentElement.dataset.godMain = `runtime.id=${typeof globalThis.chrome?.runtime?.id} sendMessage=${typeof globalThis.chrome?.runtime?.sendMessage} storage=${typeof globalThis.chrome?.storage}`;
