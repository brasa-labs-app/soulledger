/* Reconocimiento de héroes en una foto de la pantalla.
   Todo corre en el teléfono: la foto nunca se sube a ningún servidor.
   Método: el usuario encuadra la fila de retratos; se divide en N celdas y cada celda se compara
   contra los retratos oficiales de cada héroe (barra superior, tarjeta e ícono) con correlación
   normalizada por canal, que tolera el brillo, el balance de blancos y el contraste de la cámara.
   Pasada 1: búsqueda amplia para encontrar dónde está realmente cada retrato y corregir el
   espaciado (un recuadro un poco ancho o angosto acumula error hacia la última celda).
   Pasada 2: comparación fina con las celdas ya alineadas. */
const LobbyScan = (() => {
  let refs = null;            // [{id, imgs:[HTMLImageElement]}]
  let loading = null;

  function loadImg(url){
    return new Promise((res) => {
      if(!url) return res(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
    });
  }

  // heroes: [{id, refs:[url,...]}]
  function prepare(heroes){
    if(refs) return Promise.resolve(refs);
    if(loading) return loading;
    loading = Promise.all(heroes.map(async h => ({ id:h.id, imgs:(await Promise.all(h.refs.map(loadImg))).filter(Boolean) })))
      .then(r => (refs = r.filter(h => h.imgs.length)));
    return loading;
  }

  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true });

  function normalizeRange(v, off, n){
    let m=0; for(let i=0;i<n;i++) m+=v[off+i]; m/=n;
    let s=0; for(let i=0;i<n;i++){ const x=v[off+i]-m; v[off+i]=x; s+=x*x; }
    s=Math.sqrt(s)||1; for(let i=0;i<n;i++) v[off+i]/=s;
  }
  // Recorta (sx,sy,sw,sh) de src, lo reduce a w×h y devuelve vectores normalizados (color y gris)
  function sample(src, sx, sy, sw, sh, w, h){
    scratch.width = w; scratch.height = h;
    sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = "high";
    sctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    const d = sctx.getImageData(0,0,w,h).data;
    const n = w*h, c = new Float32Array(n*3), g = new Float32Array(n);
    for(let i=0;i<n;i++){
      const r=d[i*4], gg=d[i*4+1], b=d[i*4+2];
      c[i]=r; c[n+i]=gg; c[2*n+i]=b; g[i]=0.299*r+0.587*gg+0.114*b;
    }
    for(let ch=0; ch<3; ch++) normalizeRange(c, ch*n, n);
    normalizeRange(g, 0, n);
    return { c, g };
  }
  const dot = (a,b) => { let s=0; for(let i=0;i<a.length;i++) s+=a[i]*b[i]; return s; };
  // en color y en gris (el retrato de un héroe muerto sale desaturado)
  const sim = (ref, v) => Math.max(dot(ref.c, v.c)/3, dot(ref.g, v.g) - 0.04);

  // Recorte de la imagen de referencia con la proporción de la celda, sesgado hacia la cara
  function coverRect(img, aspect){
    const iw=img.naturalWidth, ih=img.naturalHeight;
    if(iw/ih > aspect){ const w=ih*aspect; return [ (iw-w)/2, 0, w, ih ]; }
    const h=iw/aspect; return [ 0, (ih-h)/4, iw, h ];
  }
  const range = (a,b,st) => { const r=[]; for(let x=a; x<=b+1e-9; x+=st) r.push(x); return r; };

  function refVectors(aspect, w, h){
    return refs.map(r => ({ id:r.id, v: r.imgs.map(img => sample(img, ...coverRect(img, aspect), w, h)) }));
  }
  // Para una celda, prueba variantes de posición/escala; devuelve por héroe su mejor puntaje y la variante ganadora
  function scoreCell(photo, rect, rv, w, h, grid){
    const variants = [];
    for(const s of grid.sc) for(const dx of grid.dx) for(const dy of grid.dy){
      const vw = rect.w*s, vh = rect.h*s;
      variants.push({ dx, v: sample(photo, rect.x + rect.w*dx + (rect.w-vw)/2, rect.y + rect.h*dy + (rect.h-vh)/2, vw, vh, w, h) });
    }
    return rv.map(r => {
      let best = -1, bdx = 0;
      for(const ref of r.v) for(const va of variants){ const sc = sim(ref, va.v); if(sc > best){ best = sc; bdx = va.dx; } }
      return { id:r.id, score:best, dx:bdx };
    }).sort((a,b)=>b.score-a.score);
  }

  /* photo: canvas o imagen; box: {x,y,w,h} en píxeles de la foto; count: retratos en el recuadro.
     Devuelve por celda: {rect, id, score, conf, alts} con héroes únicos. */
  function scan(photo, box, count = 6){
    if(!refs) throw new Error("Los retratos de referencia aún no cargan.");
    // Copia única de los píxeles a un canvas en CPU: si la foto vive en la GPU, cada recorte forzaría
    // una lectura de vuelta (Galaxy S23: 4,4 s → 0,25 s, resultados idénticos). Un drawImage solo no
    // basta: Chrome lo difiere y vuelve a leer la GPU; getImageData/putImageData fija los píxeles.
    const W = photo.naturalWidth || photo.width, H = photo.naturalHeight || photo.height;
    const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
    const tctx = tmp.getContext("2d", { willReadFrequently: true }); tctx.drawImage(photo, 0, 0);
    const cpu = document.createElement("canvas"); cpu.width = W; cpu.height = H;
    cpu.getContext("2d", { willReadFrequently: true }).putImageData(tctx.getImageData(0, 0, W, H), 0, 0);
    photo = cpu;
    const cw = box.w / count, ch = box.h, aspect = cw / ch;
    const w = 10, h = Math.max(8, Math.min(40, Math.round(w / aspect)));
    const rv = refVectors(aspect, w, h);

    // Pasada 1: dónde está cada retrato (desplazamiento horizontal en unidades de celda)
    const coarse = { sc:[0.9, 1.05], dx:range(-0.35, 0.35, 0.07), dy:range(-0.15, 0.15, 0.075) };
    const pts = [];
    for(let k=0;k<count;k++){
      const rank = scoreCell(photo, { x: box.x + k*cw, y: box.y, w: cw, h: ch }, rv, w, h, coarse);
      pts.push({ k, dx: rank[0].dx, wgt: Math.max(0.01, rank[0].score - rank[1].score) });
    }
    // ajuste lineal ponderado dx = a + b·k  (corrige posición y espaciado del recuadro)
    let sw=0, sk=0, sd=0, skk=0, skd=0;
    for(const p of pts){ sw+=p.wgt; sk+=p.wgt*p.k; sd+=p.wgt*p.dx; skk+=p.wgt*p.k*p.k; skd+=p.wgt*p.k*p.dx; }
    const den = sw*skk - sk*sk;
    let b = den ? (sw*skd - sk*sd)/den : 0; b = Math.max(-0.08, Math.min(0.08, b));
    const a = (sd - b*sk)/sw;

    // Pasada 2: celdas alineadas, comparación fina
    const fine = { sc:[0.88, 0.96, 1.04, 1.12], dx:range(-0.1, 0.1, 0.05), dy:range(-0.15, 0.15, 0.075) };
    const cells = [];
    for(let k=0;k<count;k++){
      const rect = { x: box.x + (k + a)*cw + k*b*cw, y: box.y, w: cw, h: ch };
      cells.push({ rect, ranking: scoreCell(photo, rect, rv, w, h, fine) });
    }

    // asignación única: el mejor par celda-héroe primero, luego el resto
    const taken = new Set(), assigned = new Array(count).fill(null), pairs = [];
    cells.forEach((c,i) => c.ranking.slice(0,6).forEach(r => pairs.push({ i, id:r.id, score:r.score })));
    pairs.sort((x,y)=>y.score-x.score);
    for(const p of pairs){ if(assigned[p.i] || taken.has(p.id)) continue; assigned[p.i] = p; taken.add(p.id); }
    return cells.map((c,i) => {
      const pick = assigned[i] || c.ranking[0];
      const rest = c.ranking.filter(r => r.id !== pick.id);
      return { rect:c.rect, id:pick.id, score:pick.score, conf: pick.score - (rest[0]?.score ?? 0),
        alts: [pick.id, ...rest.slice(0,4).map(r=>r.id)] };
    });
  }

  return { prepare, scan, ready: () => !!refs };
})();
