/* Comparaison de la sortie d'un programme avec l'exemple de l'énoncé.
   Espaces en fin de ligne et lignes vides au début ou à la fin ignorés.
   Une ligne "..." dans l'exemple signifie « n'importe quoi ici » : les blocs visibles
   doivent alors apparaître dans l'ordre (le premier au début si l'exemple ne commence
   pas par "..."). Un exemple abrégé peut s'arrêter avant la fin de l'exécution. */
(function (root) {
  "use strict";

  function lignes(t) {
    var l = String(t).replace(/\r/g, "").split("\n").map(function (x) { return x.replace(/\s+$/, ""); });
    while (l.length && l[0] === "") l.shift();
    while (l.length && l[l.length - 1] === "") l.pop();
    return l;
  }

  function transcript(events) {
    return events.map(function (e) { return e.t === "i" ? e.s + "\n" : e.s; }).join("");
  }

  function blocs(attendu) {
    var out = [[]], ouvertDebut = false, ouvertFin = false;
    attendu.forEach(function (l, i) {
      if (l.trim() === "...") {
        if (i === 0) ouvertDebut = true;
        if (i === attendu.length - 1) ouvertFin = true;
        if (out[out.length - 1].length) out.push([]);
      } else {
        out[out.length - 1].push(l);
      }
    });
    if (!out[out.length - 1].length) out.pop();
    return { blocs: out, debut: !ouvertDebut, fin: !ouvertFin };
  }

  function trouver(obtenu, bloc, depuis) {
    for (var i = depuis; i + bloc.length <= obtenu.length; i++) {
      var ok = true;
      for (var j = 0; j < bloc.length; j++) if (obtenu[i + j] !== bloc[j]) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  /* Renvoie { ok, mode, lignes: [{attendu, obtenu, ok}], manque: [lignes du bloc introuvable] } */
  function verifier(texteObtenu, texteAttendu) {
    var obtenu = lignes(texteObtenu);
    var attendu = lignes(texteAttendu);
    var partiel = attendu.some(function (l) { return l.trim() === "..."; });
    if (!partiel) {
      var n = Math.max(obtenu.length, attendu.length), detail = [], ok = true;
      for (var i = 0; i < n; i++) {
        var a = i < attendu.length ? attendu[i] : null, o = i < obtenu.length ? obtenu[i] : null;
        var same = a === o;
        if (!same) ok = false;
        detail.push({ attendu: a, obtenu: o, ok: same });
      }
      return { ok: ok, mode: "exact", lignes: detail };
    }
    var b = blocs(attendu), pos = 0;
    for (var k = 0; k < b.blocs.length; k++) {
      var bloc = b.blocs[k];
      var idx;
      if (k === 0 && b.debut) idx = trouver(obtenu, bloc, 0) === 0 ? 0 : -1;
      else idx = trouver(obtenu, bloc, pos);
      if (idx < 0) {
        var proche = meilleurAppui(obtenu, bloc, pos);
        return { ok: false, mode: "partiel", bloc: k + 1, total: b.blocs.length, manque: bloc, proche: proche };
      }
      pos = idx + bloc.length;
    }
    return { ok: true, mode: "partiel", total: b.blocs.length };
  }

  function meilleurAppui(obtenu, bloc, depuis) {
    var best = -1, score = -1;
    for (var i = Math.max(0, depuis); i < obtenu.length; i++) {
      var s = 0;
      for (var j = 0; j < bloc.length && i + j < obtenu.length; j++) if (obtenu[i + j] === bloc[j]) s++;
      if (s > score) { score = s; best = i; }
    }
    if (best < 0) return [];
    return obtenu.slice(best, best + bloc.length);
  }

  root.leonisVerif = { verifier: verifier, transcript: transcript, lignes: lignes };
})(typeof self !== "undefined" ? self : globalThis);
