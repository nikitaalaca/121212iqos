(() => {
  const tg = window.Telegram?.WebApp || null;
  if (tg) {
    tg.ready();
    tg.expand();
    tg.enableClosingConfirmation();
  }

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d", { alpha: true });

  // Buffers: scene -> bloom -> present + temporal blur
  const scene = document.createElement("canvas");
  const sctx = scene.getContext("2d", { alpha: true });

  const bloom = document.createElement("canvas");
  const bctx = bloom.getContext("2d", { alpha: true });

  const prev = document.createElement("canvas");
  const pctx = prev.getContext("2d", { alpha: true });

  // HUD
  const timeEl = document.getElementById("time");
  const scoreEl = document.getElementById("score");
  const multEl = document.getElementById("mult");
  const bestEl = document.getElementById("best");
  const comboEl = document.getElementById("combo");
  const startBtn = document.getElementById("start");
  const hapticBtn = document.getElementById("haptic");
  const soundBtn = document.getElementById("sound");
  const screamBtn = document.getElementById("scream");
  const qualityBtn = document.getElementById("quality");
  const progressFill = document.getElementById("progressFill");

  // (опционально) если добавишь кнопку в HTML: <button id="music" class="btn">Музыка: ON</button>
  const musicBtn = document.getElementById("music");

  let W = 0, H = 0, dpr = 1;

  // Quality presets
  const QUALITY = {
    MAX:  { bloomBlur: 22, bloomAlpha: 0.92, grainAlpha: 0.10, scanAlpha: 0.11, particles: 1.0, noiseScale: 1.0, motionBlur: 0.18 },
    HIGH: { bloomBlur: 16, bloomAlpha: 0.78, grainAlpha: 0.07, scanAlpha: 0.08, particles: 0.78, noiseScale: 1.2, motionBlur: 0.12 },
  };
  let quality = "MAX";

  // ---- assets ----
  const img = {};
  const ASSETS = {
    hole: "assets/hole.png",
    iqos: "assets/iqos.png",
    sticks: "assets/sticks.png",
    hit: "assets/hit.png",
    screamer: "assets/screamer.png",
    spark: "assets/spark.png",
    glow: "assets/glow.png",
    noise: "assets/noise.png",
  };

  // ---- MUSIC (place your legal file here) ----
  const MUSIC_SRC = "assets/music.mp3"; // <-- положи сюда свой mp3
  let music = null;
  let musicOn = true;
  let musicTargetVol = 0.32;

  function initMusic() {
    if (music) return;
    music = new Audio(MUSIC_SRC);
    music.loop = true;
    music.preload = "auto";
    music.volume = musicTargetVol;
    music.playsInline = true; // iOS
  }

  async function playMusic() {
    if (!musicOn) return;
    initMusic();
    try { await music.play(); } catch (e) { console.warn("music play blocked:", e); }
  }

  function stopMusic() {
    if (!music) return;
    music.pause();
    // music.currentTime = 0; // если хочешь сбрасывать
  }

  function tweenMusic(to, ms = 220) {
    if (!music) return;
    const from = music.volume;
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      music.volume = from + (to - from) * t;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function duckMusic() {
    if (!music || !musicOn) return;
    tweenMusic(0.06, 120);
    setTimeout(() => tweenMusic(musicTargetVol, 240), 650);
  }

  if (musicBtn) {
    musicBtn.addEventListener("click", () => {
      musicOn = !musicOn;
      musicBtn.textContent = `Музыка: ${musicOn ? "ON" : "OFF"}`;
      if (musicOn) playMusic(); else stopMusic();
      if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
    });
  }

  // ---- Layout helpers (Telegram iOS) ----
  function applyAppHeight() {
    const h = tg?.viewportStableHeight || window.innerHeight;
    document.documentElement.style.setProperty("--app-h", `${h}px`);
  }

  function resize() {
    const raw = window.devicePixelRatio || 1;
    dpr = Math.max(1, Math.min(2, raw));

    const cw = Math.max(1, Math.floor(canvas.clientWidth));
    const ch = Math.max(1, Math.floor(canvas.clientHeight));

    W = Math.floor(cw * dpr);
    H = Math.floor(ch * dpr);

    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;

    if (scene.width !== W) scene.width = W;
    if (scene.height !== H) scene.height = H;

    if (bloom.width !== W) bloom.width = W;
    if (bloom.height !== H) bloom.height = H;

    if (prev.width !== W) prev.width = W;
    if (prev.height !== H) prev.height = H;
  }

  let running = false;

  function renderIdle() {
    if (running) return;
    if (W <= 2 || H <= 2) return;
    const ts = performance.now();
    drawScene(ts);
    present(ts);
  }

  function syncLayoutAndPaint() {
    applyAppHeight();
    resize();
    renderIdle();
    requestAnimationFrame(() => {
      applyAppHeight();
      resize();
      renderIdle();
    });
  }

  window.addEventListener("resize", () => requestAnimationFrame(syncLayoutAndPaint));

  if (tg?.onEvent) {
    tg.onEvent("viewportChanged", () => requestAnimationFrame(syncLayoutAndPaint));
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => requestAnimationFrame(syncLayoutAndPaint));
    window.visualViewport.addEventListener("scroll", () => requestAnimationFrame(syncLayoutAndPaint));
  }

  function loadImages() {
    const entries = Object.entries(ASSETS);
    return Promise.all(entries.map(([k, src]) => new Promise((res) => {
      const im = new Image();
      im.onload = () => { img[k] = im; res(); };
      im.onerror = () => { console.warn("asset missing:", src); res(); };
      im.src = src;
    })));
  }

  // ---- Sound (tiny synth) ----
  let audioCtx = null;
  let soundOn = true;

  function ensureAudio() {
    if (!soundOn) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  }

  function beep({ freq=420, dur=0.06, type="sine", gain=0.05, slide=0 }) {
    if (!soundOn) return;
    ensureAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t0); o.stop(t0 + dur);
  }

  const sfx = {
    hit:   () => beep({ freq: 560, dur: 0.05, type: "triangle", gain: 0.06, slide: 240 }),
    bonus: () => { beep({ freq: 760, dur: 0.06, type: "square", gain: 0.045, slide: 260 }); setTimeout(()=>beep({freq: 1040, dur:0.07, type:"square", gain:0.04, slide:160}), 45); },
    miss:  () => beep({ freq: 165, dur: 0.08, type: "sine", gain: 0.04, slide: -70 }),
    start: () => beep({ freq: 420, dur: 0.09, type: "triangle", gain: 0.05, slide: 190 }),
    end:   () => beep({ freq: 220, dur: 0.14, type: "sine", gain: 0.04, slide: -90 }),
    combo: () => beep({ freq: 860, dur: 0.06, type: "triangle", gain: 0.05, slide: 90 }),
  };

  // ---- Game layout ----
  const GRID = [
    {x: 0.2, y: 0.25}, {x: 0.5, y: 0.25}, {x: 0.8, y: 0.25},
    {x: 0.2, y: 0.55}, {x: 0.5, y: 0.55}, {x: 0.8, y: 0.55},
    {x: 0.5, y: 0.83},
  ];

  // ---- State ----
  const durationMs = 40_000;
  let timeLeft = durationMs;
  let lastTs = 0;

  let score = 0;
  const BEST_KEY = "miniapp_best_score_v4";
  let best = Number(localStorage.getItem(BEST_KEY) || 0);
  bestEl.textContent = `BEST: ${best}`;

  let multiplier = 1;
  let multUntil = 0;

  let combo = 0;
  let comboUntil = 0;
  comboEl.textContent = "COMBO: 0";

  let intensity = 1.0;
  const baseSpawn = 0.0155;

  // premium camera FX
  let shakeUntil = 0;
  let shakePower = 0;
  let chroma = 0;
  let chromaUntil = 0;

  // slowmo
  let slowMoUntil = 0;

  // screamers
  let screamerOn = true;
  let screamerUntil = 0;
  let screamerFlash = 0;

  // particles & texts
  const particles = [];
  const texts = [];

  // holes
  const holes = GRID.map((p) => ({
    ...p,
    type: null,
    until: 0,
    cooldown: 0,
    pop: 0,
    popVel: 0,
    justHit: 0,
    ring: 0,
    ringVel: 0,
    idle: Math.random() * 10,
  }));

  // toggles
  let hapticOn = true;

  function now() { return performance.now(); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function springStep(x, v, target, dt, k=70, d=10){
    const a = (-k * (x - target) - d * v);
    v += a * dt;
    x += v * dt;
    return [x, v];
  }

  function setMultiplier(x, duration) {
    multiplier = x;
    multUntil = now() + duration;
    multEl.textContent = `x${multiplier}`;
  }

  function setCombo(newCombo) {
    combo = newCombo;
    comboEl.textContent = `COMBO: ${combo}`;
  }

  function addScore(base, x, y) {
    const total = base * multiplier;
    score += total;
    scoreEl.textContent = String(score);
    texts.push({ x, y, vy: -0.11*dpr, life: 1100, t: 0, text: `+${total}`, big: total >= 70 });
  }

  function spawnParticles(x, y, count, power, life, kind="hit") {
    const mul = QUALITY[quality].particles;
    count = Math.floor(count * mul);
    for (let i=0; i<count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = power * (0.35 + Math.random()*0.75);
      particles.push({
        x, y,
        vx: Math.cos(a)*sp,
        vy: Math.sin(a)*sp - sp*0.28,
        r: (kind==="bonus" ? 8 : 6) * (0.55 + Math.random()*0.95),
        life,
        t: 0,
        kind,
        px: x, py: y
      });
    }
  }

  function triggerScreamer(strength=1.0){
    if (!screamerOn) return;
    duckMusic(); // <-- приглушаем музыку
    const ts = now();
    screamerUntil = ts + 560;
    screamerFlash = ts + 150;
    shakeUntil = ts + 520;
    shakePower = 22 * dpr * strength;
    chromaUntil = ts + 560;
    chroma = 7 * dpr * strength;

    sfx.miss();
    setTimeout(()=>sfx.end(), 90);
    if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.impactOccurred("heavy");
  }

  function rand(min, max) { return Math.random() * (max - min) + min; }

  function spawnLogic(ts) {
    const progress = 1 - (timeLeft / durationMs);
    intensity = 1.0 + progress * 1.65;
    const pSpawn = baseSpawn * intensity;

    for (const h of holes) {
      if (h.type && ts > h.until) h.type = null;
      if (ts < h.cooldown) continue;
      if (h.type) continue;

      if (Math.random() < pSpawn) {
        const isSticks = Math.random() < 0.20;
        h.type = isSticks ? "sticks" : "iqos";
        const life = (isSticks ? rand(860, 1320) : rand(680, 1120)) / intensity;
        h.until = ts + life;
        h.cooldown = ts + rand(220, 560) / intensity;
        h.pop = 0; h.popVel = 0;
      }
    }
  }

  function update(dt, ts){
    const slow = (ts < slowMoUntil) ? 0.55 : 1.0;
    dt *= slow;

    if (multiplier > 1 && ts > multUntil) setMultiplier(1, 0);
    if (combo > 0 && ts > comboUntil) setCombo(0);

    for (const h of holes) {
      const target = h.type ? 1.0 : 0.0;
      [h.pop, h.popVel] = springStep(h.pop, h.popVel, target, dt, h.type ? 90 : 76, h.type ? 13 : 12);
      [h.ring, h.ringVel] = springStep(h.ring, h.ringVel, 0, dt, 42, 10);
      h.idle += dt * 1.2;
    }

    for (let i=particles.length-1; i>=0; i--){
      const p = particles[i];
      p.t += dt*1000;
      const t = p.t / p.life;
      if (t >= 1){ particles.splice(i,1); continue; }
      p.px = p.x; p.py = p.y;
      p.vy += 0.22 * dpr * dt * 60;
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vx *= 0.986;
      p.vy *= 0.986;
    }

    for (let i=texts.length-1; i>=0; i--){
      const tt = texts[i];
      tt.t += dt*1000;
      const t = tt.t / tt.life;
      if (t >= 1){ texts.splice(i,1); continue; }
      tt.y += tt.vy * dt * 60;
      tt.vy -= 0.0018 * dpr * dt * 60;
    }

    const pct = clamp(1 - timeLeft / durationMs, 0, 1);
    progressFill.style.width = `${(pct*100).toFixed(1)}%`;
  }

  function drawBackground(ts){
    const g1 = sctx.createRadialGradient(W*0.5, H*0.18, Math.min(W,H)*0.08, W*0.5, H*0.18, Math.max(W,H)*0.95);
    g1.addColorStop(0, "rgba(255,255,255,0.065)");
    g1.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = g1;
    sctx.fillRect(0,0,W,H);

    const x = W*(0.5 + 0.14*Math.sin(ts*0.0008));
    const y = H*(0.58 + 0.11*Math.cos(ts*0.00065));
    const g2 = sctx.createRadialGradient(x,y, Math.min(W,H)*0.05, x,y, Math.min(W,H)*0.62);
    g2.addColorStop(0, "rgba(255,105,180,0.07)");
    g2.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = g2;
    sctx.fillRect(0,0,W,H);

    const x3 = W*(0.36 + 0.10*Math.cos(ts*0.0009));
    const y3 = H*(0.40 + 0.12*Math.sin(ts*0.0007));
    const g3 = sctx.createRadialGradient(x3,y3, Math.min(W,H)*0.04, x3,y3, Math.min(W,H)*0.50);
    g3.addColorStop(0, "rgba(80,180,255,0.055)");
    g3.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = g3;
    sctx.fillRect(0,0,W,H);
  }

  function drawScene(ts){
    sctx.clearRect(0,0,W,H);

    const ground = sctx.createLinearGradient(0,0,0,H);
    ground.addColorStop(0, "rgba(60,35,24,0.36)");
    ground.addColorStop(1, "rgba(0,0,0,0.28)");
    sctx.fillStyle = ground;
    sctx.fillRect(0,0,W,H);

    drawBackground(ts);

    // frame
    sctx.save();
    sctx.globalAlpha = 0.24;
    sctx.lineWidth = 22*dpr;
    sctx.strokeStyle = "rgba(255,255,255,0.18)";
    sctx.strokeRect(14*dpr, 14*dpr, W-28*dpr, H-28*dpr);
    sctx.restore();

    const holeSize = Math.min(W,H)*0.18;
    const popSize = holeSize*0.92;

    for (const h of holes){
      const cx = h.x*W, cy=h.y*H;

      sctx.save();
      sctx.globalAlpha = 0.28;
      sctx.filter = "blur(11px)";
      sctx.beginPath();
      sctx.ellipse(cx, cy+11*dpr, holeSize*0.52, holeSize*0.36, 0, 0, Math.PI*2);
      sctx.fillStyle = "rgba(0,0,0,0.60)";
      sctx.fill();
      sctx.restore();

      if (img.hole) sctx.drawImage(img.hole, cx-holeSize/2, cy-holeSize/2, holeSize, holeSize);

      if (h.ring > 0.02 && img.glow){
        const r = holeSize*(0.88 + h.ring*0.70);
        sctx.save();
        sctx.globalAlpha = 0.62*h.ring;
        sctx.drawImage(img.glow, cx-r/2, cy-r/2, r, r);
        sctx.restore();
      }

      if (h.type){
        const pop = clamp(h.pop, 0, 1);
        const bob = Math.sin(h.idle*6.2) * 4*dpr * (0.15 + 0.35*pop);

        if (h.type === "iqos" && img.iqos){
          const w = popSize*1.15*pop;
          const hh = popSize*2.08*pop;
          const yy = cy - hh + holeSize*0.28 + bob;

          sctx.save();
          sctx.globalAlpha = 0.35;
          sctx.filter = "blur(8px)";
          sctx.drawImage(img.iqos, cx-w/2+10*dpr, yy+16*dpr, w, hh);
          sctx.restore();

          sctx.drawImage(img.iqos, cx-w/2, yy, w, hh);

          sctx.save();
          sctx.globalAlpha = 0.10;
          sctx.fillStyle = "rgba(255,255,255,1)";
          sctx.fillRect(cx - w*0.22, yy + hh*0.12, w*0.08, hh*0.76);
          sctx.restore();
        }

        if (h.type === "sticks" && img.sticks){
          const w = popSize*1.42*pop;
          const hh = popSize*1.00*pop;
          const yy = cy - hh + holeSize*0.20 + bob*0.6;

          const rot = Math.sin(h.idle*5.4) * 0.03 * pop;
          sctx.save();
          sctx.translate(cx, yy + hh*0.55);
          sctx.rotate(rot);
          sctx.shadowColor = "rgba(255, 77, 196, 0.98)";
          sctx.shadowBlur = 42*dpr;
          sctx.drawImage(img.sticks, -w/2, -hh*0.55, w, hh);
          sctx.restore();
        }
      }

      if (h.justHit && ts < h.justHit && img.hit){
        const a = (h.justHit - ts)/200;
        sctx.save();
        sctx.globalAlpha = clamp(a,0,1);
        sctx.drawImage(img.hit, cx-popSize/2, cy-popSize/2, popSize, popSize);
        sctx.restore();
      }
    }

    for (const p of particles){
      const t = p.t / p.life;
      const a = 1 - t;

      sctx.save();
      sctx.globalAlpha = a*0.35;
      sctx.lineWidth = (p.kind==="bonus"? 9:7)*dpr;
      sctx.strokeStyle = (p.kind==="bonus") ? "rgba(255,105,180,1)" : "rgba(255,255,255,1)";
      sctx.beginPath();
      sctx.moveTo(p.px, p.py);
      sctx.lineTo(p.x, p.y);
      sctx.stroke();
      sctx.restore();

      sctx.save();
      sctx.globalAlpha = a*0.92;
      if (img.spark && p.kind!=="bonus"){
        const s = p.r*6.4;
        sctx.drawImage(img.spark, p.x-s/2, p.y-s/2, s, s);
      } else {
        sctx.beginPath();
        sctx.arc(p.x, p.y, p.r*(1-t*0.4), 0, Math.PI*2);
        sctx.fillStyle = (p.kind==="bonus") ? "rgba(255,105,180,1)" : "rgba(255,255,255,1)";
        sctx.fill();
      }
      sctx.restore();
    }

    for (const tt of texts){
      const t = tt.t / tt.life;
      const a = 1 - t;
      sctx.save();
      sctx.globalAlpha = a;
      sctx.font = `${(tt.big? 30:24)*dpr}px -apple-system, system-ui, Segoe UI, Roboto, Arial`;
      sctx.textAlign = "center";
      sctx.textBaseline = "middle";
      sctx.shadowColor = "rgba(0,0,0,0.70)";
      sctx.shadowBlur = 14*dpr;
      sctx.fillStyle = "rgba(255,255,255,0.96)";
      sctx.fillText(tt.text, tt.x, tt.y);
      sctx.restore();
    }
  }

  function present(ts){
    const q = QUALITY[quality];

    bctx.clearRect(0,0,W,H);
    bctx.save();
    bctx.globalAlpha = q.bloomAlpha;
    bctx.filter = `blur(${q.bloomBlur}px)`;
    bctx.drawImage(scene, 0, 0);
    bctx.restore();

    ctx.clearRect(0,0,W,H);

    if (q.motionBlur > 0){
      ctx.save();
      ctx.globalAlpha = q.motionBlur;
      ctx.drawImage(prev, 0, 0);
      ctx.restore();
    }

    let ox=0, oy=0;
    if (ts < shakeUntil){
      const t = (shakeUntil - ts)/520;
      const p = shakePower*t;
      ox = (Math.random()*2-1)*p;
      oy = (Math.random()*2-1)*p;
    }
    const c = (ts < chromaUntil) ? chroma * ((chromaUntil - ts)/560) : 0;

    ctx.save();
    ctx.translate(ox, oy);

    if (c > 0.5){
      ctx.globalAlpha = 0.85;
      ctx.drawImage(scene, -c, 0);
      ctx.globalAlpha = 0.65;
      ctx.drawImage(scene, c, 0);
      ctx.globalAlpha = 1.0;
      ctx.drawImage(scene, 0, 0);
    } else {
      ctx.drawImage(scene, 0, 0);
    }

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.90;
    ctx.drawImage(bloom, 0, 0);
    ctx.restore();

    ctx.restore();

    const vg = ctx.createRadialGradient(W*0.5, H*0.42, Math.min(W,H)*0.18, W*0.5, H*0.58, Math.max(W,H)*0.98);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.60)");
    ctx.fillStyle = vg;
    ctx.fillRect(0,0,W,H);

    ctx.save();
    ctx.globalAlpha = q.scanAlpha;
    for (let y=0; y<H; y+= (6*dpr)){
      ctx.fillStyle = "rgba(0,0,0,0.20)";
      ctx.fillRect(0, y, W, 2*dpr);
    }
    ctx.restore();

    if (img.noise){
      ctx.save();
      ctx.globalAlpha = q.grainAlpha;
      const s = 256 * dpr * q.noiseScale;
      const oxn = (ts*0.07) % s;
      const oyn = (ts*0.05) % s;
      for (let y= -s; y<H+s; y+=s){
        for (let x= -s; x<W+s; x+=s){
          ctx.drawImage(img.noise, x-oxn, y-oyn, s, s);
        }
      }
      ctx.restore();
    }

    if (ts < screamerUntil){
      const t = 1 - (screamerUntil - ts)/560;
      const a = (1 - t) * 0.92;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = "rgba(0,0,0,0.74)";
      ctx.fillRect(0,0,W,H);

      const s = Math.min(W,H)*(0.96 + 0.06*Math.sin(ts*0.09));
      const x = (W-s)/2;
      const y = (H-s)/2 - Math.sin(ts*0.12)*12*dpr;
      if (img.screamer) ctx.drawImage(img.screamer, x, y, s, s);

      ctx.globalAlpha = 0.32;
      for (let i=0;i<22;i++){
        const yy = (Math.random()*H)|0;
        const hh = (Math.random()*16+4)*dpr;
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(0, yy, W, hh);
      }
      ctx.restore();
    }
    if (ts < screamerFlash){
      const a = (screamerFlash - ts)/150;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = "rgba(255,255,255,0.68)";
      ctx.fillRect(0,0,W,H);
      ctx.restore();
    }

    pctx.clearRect(0,0,W,H);
    pctx.drawImage(canvas, 0, 0);
  }

  function loop(ts){
    if (!running) return;

    if (!lastTs) lastTs = ts;
    let dt = (ts - lastTs) / 1000;
    lastTs = ts;
    dt = clamp(dt, 0, 0.05);

    const slow = (ts < slowMoUntil) ? 0.55 : 1.0;
    timeLeft -= dt * 1000 * slow;
    timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft/1000)));

    spawnLogic(ts);
    update(dt, ts);
    drawScene(ts);
    present(ts);

    if (screamerOn && Math.random() < 0.00055) triggerScreamer(0.85);

    if (timeLeft <= 0){
      endGame();
      return;
    }
    requestAnimationFrame(loop);
  }

  function startGame(){
    running = true;

    // iOS: музыка/звук должны стартовать от user gesture
    ensureAudio();
    playMusic();

    timeLeft = durationMs;
    score = 0;
    scoreEl.textContent = "0";
    setMultiplier(1, 0);
    setCombo(0);
    lastTs = 0;

    particles.length = 0;
    texts.length = 0;
    shakeUntil = 0;
    chromaUntil = 0;
    slowMoUntil = 0;
    pctx.clearRect(0,0,W,H);

    for (const h of holes){
      h.type = null; h.until = 0; h.cooldown = 0;
      h.pop = 0; h.popVel = 0;
      h.justHit = 0;
      h.ring = 0; h.ringVel = 0;
    }

    if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.selectionChanged();
    sfx.start();
    requestAnimationFrame(loop);
  }

  function endGame(){
    running = false;
    sfx.end();
    stopMusic();

    if (score > best){
      best = score;
      localStorage.setItem(BEST_KEY, String(best));
      bestEl.textContent = `BEST: ${best}`;
    }

    tg?.showPopup?.({
      title: "Игра окончена",
      message: `Счёт: ${score}\nРекорд: ${best}`,
      buttons: [{type:"ok"}]
    });

    requestAnimationFrame(renderIdle);
  }

  function impactFX(power=1.0){
    const ts = now();
    shakeUntil = ts + 190;
    shakePower = 10*dpr*power;
    chromaUntil = ts + 280;
    chroma = 5*dpr*power;
  }

  function hitAt(clientX, clientY){
    if (!running) return;

    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * dpr;
    const y = (clientY - rect.top) * dpr;

    const holeSize = Math.min(W,H)*0.18;
    let didHit = false;

    for (const h of holes){
      const cx = h.x*W, cy=h.y*H;
      const dx = x - cx;
      const dy = y - (cy - holeSize*0.18);
      const r = holeSize*0.56;

      if (dx*dx + dy*dy <= r*r){
        if (h.type){
          didHit = true;

          h.justHit = now() + 220;
          h.ring = 1.0; h.ringVel = 0;
          impactFX(1.0);

          if (h.type === "sticks"){
            setMultiplier(2, 10_000);
            slowMoUntil = now() + 720;
            spawnParticles(cx, cy - holeSize*0.25, 42, 13*dpr, 1200, "bonus");
            texts.push({ x: cx, y: cy - holeSize*0.78, vy: -0.13*dpr, life: 1250, t: 0, text: "x2 BOOST!", big: true });
            sfx.bonus();
            if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.impactOccurred("medium");
          } else {
            const base = 30 + Math.min(90, combo*4);
            addScore(base, cx, cy - holeSize*0.58);

            combo += 1;
            comboUntil = now() + 2000;
            comboEl.textContent = `COMBO: ${combo}`;
            if (combo % 5 === 0) sfx.combo();

            spawnParticles(cx, cy - holeSize*0.25, 28, 11*dpr, 1000, "hit");
            sfx.hit();
            if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.impactOccurred("light");
          }

          h.type = null;
          h.until = 0;
          break;
        }
      }
    }

    if (!didHit){
      sfx.miss();
      if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.notificationOccurred("warning");
      if (screamerOn && Math.random() < 0.05) triggerScreamer(1.0);
    }
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    hitAt(e.clientX, e.clientY);
  });

  startBtn.addEventListener("click", () => startGame());

  hapticBtn.addEventListener("click", () => {
    hapticOn = !hapticOn;
    hapticBtn.textContent = `Вибро: ${hapticOn ? "ON" : "OFF"}`;
    if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.selectionChanged();
  });

  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    soundBtn.textContent = `Звук: ${soundOn ? "ON" : "OFF"}`;
    if (soundOn) ensureAudio();
  });

  screamBtn.addEventListener("click", () => {
    screamerOn = !screamerOn;
    screamBtn.textContent = `Скримеры: ${screamerOn ? "ON" : "OFF"}`;
    if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.selectionChanged();
  });

  qualityBtn.addEventListener("click", () => {
    quality = (quality === "MAX") ? "HIGH" : "MAX";
    qualityBtn.textContent = `Качество: ${quality}`;
    if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.selectionChanged();
    requestAnimationFrame(() => { resize(); renderIdle(); });
  });

  // init
  syncLayoutAndPaint();
  loadImages().then(() => requestAnimationFrame(syncLayoutAndPaint));
})();
