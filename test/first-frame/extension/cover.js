globalThis.inputs = [];
for (const type of ["mousedown", "keydown"]) addEventListener(type, () => inputs.push(type), true);
