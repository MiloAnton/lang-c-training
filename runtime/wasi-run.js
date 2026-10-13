/* Exécute un programme C compilé en WebAssembly (WASI preview 1).
   L'entrée standard est rejouée : on fournit les lignes déjà tapées ; si le programme
   en demande une de plus, on s'arrête et on la réclame à l'utilisateur, puis on relance
   depuis le début. L'horloge et le hasard sont figés par session pour que chaque
   relance redonne exactement la même exécution. */
(function (root) {
  "use strict";

  var ERRNO = { SUCCESS: 0, BADF: 8, INVAL: 28, NOENT: 44, NOSYS: 52, NOTDIR: 54, ISDIR: 31, EXIST: 20, SPIPE: 70 };

  function NeedInput() { this.needInput = true; }
  function Exit(code) { this.exitCode = code; }
  function TooMuch() { this.tooMuch = true; }

  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s & 255;
    };
  }

  function run(module, opts) {
    var lines = opts.lines || [];
    var eof = !!opts.eof;
    var maxOut = opts.maxOut || 200000;
    var events = [];
    var outCount = 0;
    var enc = new TextEncoder();
    var dec = new TextDecoder();
    var flux = { 1: new TextDecoder(), 2: new TextDecoder() };
    var lineIdx = 0;
    var pending = null;
    var startNs = BigInt(opts.timeMs || Date.now()) * 1000000n;
    var sleptNs = 0n;
    var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    var rand = rng(opts.seed || 12345);

    var files = {};
    Object.keys(opts.files || {}).forEach(function (k) { files[k] = enc.encode(opts.files[k]); });
    var fds = {};
    var nextFd = 4;

    var memory = null;
    function mem() { return new DataView(memory.buffer); }
    function bytes() { return new Uint8Array(memory.buffer); }

    function pushOut(kind, text) {
      outCount += text.length;
      var last = events[events.length - 1];
      if (last && last.t === kind) last.s += text; else events.push({ t: kind, s: text });
      if (outCount > maxOut) throw new TooMuch();
    }

    function iovs(ptr, len) {
      var v = mem(), out = [];
      for (var i = 0; i < len; i++) out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]);
      return out;
    }
    function readStr(ptr, len) { return dec.decode(bytes().slice(ptr, ptr + len)); }
    function normPath(p) { return p.replace(/^\.\//, "").replace(/^\//, ""); }

    var wasi = {
      args_sizes_get: function (argc, bufSize) { var v = mem(); v.setUint32(argc, 1, true); v.setUint32(bufSize, 6, true); return 0; },
      args_get: function (argv, buf) { var v = mem(); v.setUint32(argv, buf, true); bytes().set(enc.encode("a.out\0"), buf); return 0; },
      environ_sizes_get: function (c, s) { var v = mem(); v.setUint32(c, 0, true); v.setUint32(s, 0, true); return 0; },
      environ_get: function () { return 0; },
      clock_res_get: function (id, out) { mem().setBigUint64(out, 1000n, true); return 0; },
      clock_time_get: function (id, prec, out) {
        var ns;
        if (id === 0) ns = startNs + sleptNs;
        else {
          var now = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
          ns = BigInt(Math.floor(now * 1e6)) + sleptNs;
        }
        mem().setBigUint64(out, ns, true);
        return 0;
      },
      random_get: function (buf, len) { var b = bytes(); for (var i = 0; i < len; i++) b[buf + i] = rand(); return 0; },
      sched_yield: function () { return 0; },
      proc_exit: function (code) { throw new Exit(code); },
      poll_oneoff: function (inPtr, outPtr, n, nEvents) {
        var v = mem();
        for (var i = 0; i < n; i++) {
          var sub = inPtr + i * 48;
          var userdata = v.getBigUint64(sub, true);
          var tag = v.getUint8(sub + 8);
          if (tag === 0) {
            var timeout = v.getBigUint64(sub + 24, true);
            var flags = v.getUint16(sub + 40, true);
            sleptNs += (flags & 1) ? 0n : timeout;
          }
          var ev = outPtr + i * 32;
          v.setBigUint64(ev, userdata, true);
          v.setUint16(ev + 8, 0, true);
          v.setUint8(ev + 10, tag);
        }
        v.setUint32(nEvents, n, true);
        return 0;
      },
      fd_write: function (fd, iov, iovLen, nwritten) {
        var total = 0, list = iovs(iov, iovLen), b = bytes();
        if (fd === 1 || fd === 2) {
          var chunk = new Uint8Array(0);
          list.forEach(function (e) {
            var part = b.slice(e[0], e[0] + e[1]);
            var merged = new Uint8Array(chunk.length + part.length);
            merged.set(chunk); merged.set(part, chunk.length); chunk = merged;
            total += e[1];
          });
          var txt = flux[fd].decode(chunk, { stream: true });
          if (txt) pushOut(fd === 1 ? "o" : "e", txt);
        } else if (fds[fd]) {
          var f = fds[fd];
          list.forEach(function (e) {
            var part = b.slice(e[0], e[0] + e[1]);
            var data = files[f.path];
            var pos = f.append ? data.length : f.pos;
            var size = Math.max(data.length, pos + part.length);
            var grown = new Uint8Array(size); grown.set(data); grown.set(part, pos);
            files[f.path] = grown;
            f.pos = pos + part.length;
            total += e[1];
          });
        } else return ERRNO.BADF;
        mem().setUint32(nwritten, total, true);
        return 0;
      },
      fd_read: function (fd, iov, iovLen, nread) {
        var list = iovs(iov, iovLen), b = bytes(), total = 0;
        if (fd === 0) {
          if (pending === null || pending.length === 0) {
            if (lineIdx < lines.length) {
              var line = lines[lineIdx++];
              events.push({ t: "i", s: line });
              pending = enc.encode(line + "\n");
            } else if (eof) {
              mem().setUint32(nread, 0, true);
              return 0;
            } else {
              throw new NeedInput();
            }
          }
          list.forEach(function (e) {
            var n = Math.min(e[1], pending.length);
            b.set(pending.subarray(0, n), e[0]);
            pending = pending.subarray(n);
            total += n;
          });
        } else if (fds[fd]) {
          var f = fds[fd], data = files[f.path];
          list.forEach(function (e) {
            var n = Math.max(0, Math.min(e[1], data.length - f.pos));
            b.set(data.subarray(f.pos, f.pos + n), e[0]);
            f.pos += n; total += n;
          });
        } else return ERRNO.BADF;
        mem().setUint32(nread, total, true);
        return 0;
      },
      fd_close: function (fd) { if (fds[fd]) { delete fds[fd]; return 0; } return fd < 4 ? 0 : ERRNO.BADF; },
      fd_seek: function (fd, offset, whence, newOff) {
        var f = fds[fd];
        if (!f) return fd < 3 ? ERRNO.SPIPE : ERRNO.BADF;
        var size = files[f.path].length, base = whence === 0 ? 0 : whence === 1 ? f.pos : size;
        var p = base + Number(offset);
        if (p < 0) return ERRNO.INVAL;
        f.pos = p;
        mem().setBigUint64(newOff, BigInt(p), true);
        return 0;
      },
      fd_tell: function (fd, out) { var f = fds[fd]; if (!f) return ERRNO.BADF; mem().setBigUint64(out, BigInt(f.pos), true); return 0; },
      fd_fdstat_get: function (fd, out) {
        var v = mem();
        var type = fd < 3 ? 2 : fd === 3 ? 3 : fds[fd] ? 4 : -1;
        if (type < 0) return ERRNO.BADF;
        for (var i = 0; i < 24; i++) v.setUint8(out + i, 0);
        v.setUint8(out, type);
        v.setBigUint64(out + 8, 0xffffffffn, true);
        v.setBigUint64(out + 16, 0xffffffffn, true);
        return 0;
      },
      fd_fdstat_set_flags: function () { return 0; },
      fd_filestat_get: function (fd, out) {
        var v = mem();
        for (var i = 0; i < 64; i++) v.setUint8(out + i, 0);
        if (fd < 3) { v.setUint8(out + 16, 2); return 0; }
        if (fd === 3) { v.setUint8(out + 16, 3); return 0; }
        if (!fds[fd]) return ERRNO.BADF;
        v.setUint8(out + 16, 4);
        v.setBigUint64(out + 32, BigInt(files[fds[fd].path].length), true);
        return 0;
      },
      fd_prestat_get: function (fd, out) {
        if (fd !== 3) return ERRNO.BADF;
        var v = mem(); v.setUint8(out, 0); v.setUint32(out + 4, 1, true); return 0;
      },
      fd_prestat_dir_name: function (fd, ptr, len) { if (fd !== 3) return ERRNO.BADF; bytes()[ptr] = 46; return 0; },
      path_open: function (dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInh, fdflags, outFd) {
        var path = normPath(readStr(pathPtr, pathLen));
        var creat = oflags & 1, excl = oflags & 4, trunc = oflags & 8;
        if (path === "" || path === ".") return ERRNO.ISDIR;
        if (!(path in files)) {
          if (!creat) return ERRNO.NOENT;
          files[path] = new Uint8Array(0);
        } else if (excl && creat) return ERRNO.EXIST;
        if (trunc) files[path] = new Uint8Array(0);
        var fd = nextFd++;
        fds[fd] = { path: path, pos: 0, append: !!(fdflags & 1) };
        mem().setUint32(outFd, fd, true);
        return 0;
      },
      path_filestat_get: function (dirfd, flags, pathPtr, pathLen, out) {
        var path = normPath(readStr(pathPtr, pathLen));
        var v = mem();
        for (var i = 0; i < 64; i++) v.setUint8(out + i, 0);
        if (path === "" || path === ".") { v.setUint8(out + 16, 3); return 0; }
        if (!(path in files)) return ERRNO.NOENT;
        v.setUint8(out + 16, 4);
        v.setBigUint64(out + 32, BigInt(files[path].length), true);
        return 0;
      },
      path_unlink_file: function (dirfd, pathPtr, pathLen) {
        var path = normPath(readStr(pathPtr, pathLen));
        if (!(path in files)) return ERRNO.NOENT;
        delete files[path];
        return 0;
      },
      path_rename: function (fd1, p1, l1, fd2, p2, l2) {
        var a = normPath(readStr(p1, l1)), b2 = normPath(readStr(p2, l2));
        if (!(a in files)) return ERRNO.NOENT;
        files[b2] = files[a]; delete files[a];
        return 0;
      }
    };

    var imports = { wasi_snapshot_preview1: {} };
    WebAssembly.Module.imports(module).forEach(function (imp) {
      if (imp.kind !== "function") return;
      imports[imp.module] = imports[imp.module] || {};
      imports[imp.module][imp.name] = (imp.module === "wasi_snapshot_preview1" && wasi[imp.name])
        ? wasi[imp.name]
        : function () { return ERRNO.NOSYS; };
    });

    var status = "exit", code = 0, error = null;
    try {
      var inst = new WebAssembly.Instance(module, imports);
      memory = inst.exports.memory;
      inst.exports._start();
    } catch (e) {
      if (e instanceof Exit) code = e.exitCode;
      else if (e instanceof NeedInput) status = "input";
      else if (e instanceof TooMuch) { status = "toomuch"; }
      else { status = "crash"; error = String(e && e.message || e); }
    }
    var outFiles = {};
    Object.keys(files).forEach(function (k) { outFiles[k] = dec.decode(files[k]); });
    return { status: status, code: code, error: error, events: events, files: outFiles };
  }

  root.leonisRun = run;
})(typeof self !== "undefined" ? self : globalThis);

if (typeof self !== "undefined" && typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = function (ev) {
    var r = self.leonisRun(ev.data.module, ev.data.opts);
    r.id = ev.data.id;
    self.postMessage(r);
  };
}
