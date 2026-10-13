/* Worker de compilation : charge Clang (WebAssembly) une seule fois, puis compile à la demande. */
const BASE = new URL("./clang/", import.meta.url);
const GROS = {
  "llvm.core.wasm": { parts: ["llvm-core-gz-0.wasm", "llvm-core-gz-1.wasm"], type: "application/wasm" },
  "llvm-resources.tar": { parts: ["llvm-resources-gz.wasm"], type: "application/x-tar" }
};
const TOTAL = 11500000 + 11157877 + 4246429;
let recu = 0;

function progres() {
  self.postMessage({ type: "progress", loaded: recu, total: TOTAL });
}

async function chargerMorceaux(parts, type) {
  const blocs = [];
  for (const p of parts) {
    const rep = await fetch(new URL(p, BASE));
    if (!rep.ok) throw new Error("Téléchargement impossible : " + p + " (" + rep.status + ")");
    const lecteur = rep.body.getReader();
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      blocs.push(value);
      recu += value.length;
      progres();
    }
  }
  const brut = new Blob(blocs);
  const tete = new Uint8Array(await brut.slice(0, 2).arrayBuffer());
  const estGzip = tete[0] === 0x1f && tete[1] === 0x8b;
  const flux = estGzip ? brut.stream().pipeThrough(new DecompressionStream("gzip")) : brut.stream();
  return new Response(flux, { headers: { "content-type": type } });
}

const fetchOrigine = self.fetch.bind(self);
self.fetch = function (url, options) {
  const nom = String(url).split("/").pop().split("?")[0];
  if (GROS[nom]) return chargerMorceaux(GROS[nom].parts, GROS[nom].type);
  return fetchOrigine(url, options);
};

const PRELUDE = "#include <stdio.h>\n__attribute__((constructor)) static void leonis_init(void) { setvbuf(stdout, NULL, _IONBF, 0); }\n";
let clang = null;

async function pret() {
  if (!clang) {
    clang = import("./clang/bundle.js");
  }
  return clang;
}

self.onmessage = async (ev) => {
  const { id, code, type } = ev.data;
  try {
    const { runClang } = await pret();
    if (type === "warmup") {
      await runClang(["clang", "-std=c11", "-c", "x.c", "-o", "x.o"], { "x.c": "int x;\n" });
      self.postMessage({ type: "ready", id });
      return;
    }
    let diag = "";
    const dec = new TextDecoder();
    let fichiers = null;
    try {
      fichiers = await runClang(
        ["clang", "-std=c11", "-Wall", "-Wextra", "-O1", "-fno-color-diagnostics", "-D_DEFAULT_SOURCE", "-D_WASI_EMULATED_PROCESS_CLOCKS", "-D_WASI_EMULATED_SIGNAL", "-D_WASI_EMULATED_GETPID", "-D_WASI_EMULATED_MMAN", "main.c", "leonis.c", "-lm", "-lwasi-emulated-process-clocks", "-lwasi-emulated-signal", "-lwasi-emulated-getpid", "-lwasi-emulated-mman", "-o", "a.out"],
        { "main.c": code, "leonis.c": PRELUDE },
        { stdout: (b) => { if (b) diag += dec.decode(b); }, stderr: (b) => { if (b) diag += dec.decode(b); } }
      );
    } catch (e) {
      if (!(e && typeof e.code === "number")) throw e;
    }
    const wasm = fichiers && fichiers["a.out"];
    if (wasm) {
      const module = await WebAssembly.compile(wasm);
      self.postMessage({ type: "compiled", id, ok: true, diag, module });
    } else {
      self.postMessage({ type: "compiled", id, ok: false, diag });
    }
  } catch (e) {
    self.postMessage({ type: "fatal", id, message: String(e && e.message || e) });
  }
};
