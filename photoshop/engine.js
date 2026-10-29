// Glass engine bridge: native hybrid addon if present, else the same Rust core compiled to wasm.
// render(params: Float32Array, backdrop: Uint8Array(w*h*4), masks: Uint8Array(k*w*h), w, h)
//   -> { glass: Uint8Array(w*h*4), under: Uint8Array(w*h*4) }   (under = shadow + dim halo layer)
//   `masks` = k shape masks back to back; they fuse into one liquid body.
// fill(stream: Float32Array, w, h) -> Uint8Array(w*h)   exact anti-aliased mask of vector paths (see glass_core::fill_paths)

function createWasmEngine(bytes) {
  // UXP forbids async wasm compilation, so compile synchronously.
  const ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
  // Allocates the blocks, runs `fn(ptrs)`, frees them whatever happens.
  function withMemory(sizes, fn) {
    const ptrs = sizes.map((s) => ex.lg_alloc(s));
    try {
      if (ptrs.includes(0)) throw new Error("glass engine out of memory");
      return fn(ptrs);
    } finally {
      ptrs.forEach((p, i) => p && ex.lg_free(p, sizes[i]));
    }
  }
  return {
    kind: "wasm",
    render(params, backdrop, masks, w, h) {
      const n = w * h;
      if (!masks.length || masks.length % n) throw new Error("masks must be whole w*h planes");
      // The engine reads exactly this many settings; a shorter array would make it read past the buffer.
      if (params.length !== ex.lg_param_count()) throw new Error(`expected ${ex.lg_param_count()} settings, got ${params.length}`);
      return withMemory([params.length * 4, n * 4, masks.length, n * 4, n * 4], (ptrs) => {
        // Views must be recreated after allocation: memory may have grown.
        const dv = new DataView(ex.memory.buffer);
        params.forEach((v, i) => dv.setFloat32(ptrs[0] + i * 4, v, true));
        const mem = new Uint8Array(ex.memory.buffer);
        mem.set(backdrop, ptrs[1]);
        mem.set(masks, ptrs[2]);
        const rc = ex.lg_render(ptrs[0], ptrs[1], ptrs[2], masks.length / n, w, h, ptrs[3], ptrs[4]);
        if (rc !== 0) throw new Error("glass engine error " + rc);
        const out = new Uint8Array(ex.memory.buffer);
        return { glass: out.slice(ptrs[3], ptrs[3] + n * 4), under: out.slice(ptrs[4], ptrs[4] + n * 4) };
      });
    },
    fill(stream, w, h) {
      return withMemory([stream.length * 4, w * h], (ptrs) => {
        const dv = new DataView(ex.memory.buffer);
        stream.forEach((v, i) => dv.setFloat32(ptrs[0] + i * 4, v, true));
        const rc = ex.lg_fill(ptrs[0], stream.length, w, h, ptrs[1]);
        if (rc !== 0) throw new Error("path fill error " + rc);
        return new Uint8Array(ex.memory.buffer).slice(ptrs[1], ptrs[1] + w * h);
      });
    },
  };
}

function loadEngine() {
  let native = null;
  try {
    // shortcut: interface of the C++ shim is defined by us once the Hybrid SDK is in hand; see README.
    native = require("liquidglass.uxpaddon");
  } catch (e) { /* no addon installed */ }
  // UXP can return an empty object for a missing addon instead of throwing, so check the functions themselves.
  if (native && typeof native.render === "function" && typeof native.fill === "function") {
    return { kind: "native", render: native.render, fill: native.fill };
  }
  return createWasmEngine(require("fs").readFileSync("plugin:/glass_core.wasm"));
}

module.exports = { loadEngine, createWasmEngine };
