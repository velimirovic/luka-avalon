/* ==========================================================
   Avalon · Luka Edition — Audio Moderator
   ========================================================== */
(() => {
  "use strict";

  // ---------- Game data ----------
  const AUDIO_DIR = "audio/"; // relative, so it works on GitHub Pages project sites

  const ROLES = {
    merlin:   { name: "Merlin",   team: "good" },
    persival: { name: "Persival", team: "good" },
    mordred:  { name: "Mordred",  team: "evil" },
    ubica:    { name: "Ubica",    team: "evil" },
    morgana:  { name: "Morgana",  team: "evil" },
  };

  // [good, evil] per player count (standard Avalon table)
  const TEAMS = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };

  const V_BASIC   = ["merlin", "ubica"];
  const V_MORDRED = ["merlin", "mordred", "ubica"];
  const V_FULL    = ["merlin", "persival", "mordred", "ubica", "morgana"];

  const VARIANTS = {
    5:  [V_BASIC],
    6:  [V_BASIC, V_MORDRED],
    7:  [V_MORDRED, V_FULL],
    8:  [V_MORDRED, V_FULL],
    9:  [V_FULL],
    10: [V_FULL],
  };

  // Serbian plural forms: 1 Seljak, 2–4 Seljaka, 5+ Seljaka (Zli / Zla / Zlih)
  const seljak = (n, evil) => {
    const adj = n === 1 ? "Zli " : n <= 4 ? "Zla " : "Zlih ";
    return (evil ? adj : "") + (n === 1 ? "Seljak" : "Seljaka");
  };

  const R = (key) => `<span class="role ${ROLES[key].team}">${ROLES[key].name}</span>`;

  const STEPS = {
    intro: {
      file: "0_uvod.mp3",
      title: "Nightfall",
      desc: () => "All players close their eyes and extend a fist in front of them.",
    },
    evil: {
      file: "1_zlo.mp3",
      title: "The Evil Awakens",
      desc: () => "The servants of evil open their eyes and recognise each other.",
    },
    merlin: {
      file: "2_merlin.mp3",
      title: "Merlin",
      desc: (roles) =>
        `Evil raises a thumb, ${R("merlin")} opens their eyes and sees them.` +
        (roles.includes("mordred") ? ` ${R("mordred")} stays hidden.` : ""),
    },
    persival: {
      file: "3_persival.mp3",
      title: "Persival",
      desc: () =>
        `${R("merlin")} and ${R("morgana")} raise a thumb, ${R("persival")} must find the true Merlin.`,
    },
    end: {
      file: "4_kraj.mp3",
      title: "Dawn",
      desc: () => "Everyone opens their eyes. The quest begins.",
    },
  };

  const buildQueue = (roles) => {
    const keys = ["intro", "evil", "merlin"];
    if (roles.includes("persival") && roles.includes("morgana")) keys.push("persival");
    keys.push("end");
    return keys.map((k) => ({ key: k, ...STEPS[k] }));
  };

  const GAPS = [0, 1, 2, 5]; // seconds of silence between steps
  const DEFAULT_GAP = 2;

  // ---------- Persisted preferences ----------
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem("avalon:" + k); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem("avalon:" + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- State ----------
  const state = {
    players: VARIANTS[store.get("players", 5)] ? store.get("players", 5) : 5,
    variant: store.get("variant", 0),
    gap: GAPS.includes(store.get("gapSeconds", DEFAULT_GAP)) ? store.get("gapSeconds", DEFAULT_GAP) : DEFAULT_GAP,
    queue: [],
    index: 0,
    status: "idle", // idle | playing | paused | gap | done
    gapLeft: 0,
  };
  if (!VARIANTS[state.players][state.variant]) state.variant = 0;

  const durations = {}; // file -> seconds
  const audio = new Audio();
  audio.preload = "auto";
  let rafId = null;
  let gapTimer = null;
  let wakeLock = null;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    setup: $("setup"), lockHint: $("lockHint"),
    countTabs: $("countTabs"), teams: $("teams"), variants: $("variants"),
    nowLabel: $("nowLabel"), nowTitle: $("nowTitle"), nowDesc: $("nowDesc"),
    playBtn: $("playBtn"), playIco: $("playIco"), playCaption: $("playCaption"),
    progress: $("progress"), segments: $("segments"),
    timeElapsed: $("timeElapsed"), timeStep: $("timeStep"), timeTotal: $("timeTotal"),
    restartBtn: $("restartBtn"), stopBtn: $("stopBtn"), gapSeg: $("gapSeg"), error: $("error"),
  };

  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const roles = () => VARIANTS[state.players][state.variant];
  const isActive = () => state.status === "playing" || state.status === "paused" || state.status === "gap";
  const dur = (step) => durations[step.file] || 0;
  const totalDuration = () => state.queue.reduce((sum, s) => sum + dur(s), 0);
  const elapsedBefore = (i) => state.queue.slice(0, i).reduce((sum, s) => sum + dur(s), 0);
  const currentTime = () => {
    if (state.status === "idle") return 0;
    if (state.status === "done") return totalDuration();
    if (state.status === "gap") return elapsedBefore(state.index);
    return elapsedBefore(state.index) + (audio.currentTime || 0);
  };

  // ---------- Setup rendering ----------
  function renderCountTabs() {
    el.countTabs.innerHTML = "";
    Object.keys(VARIANTS).forEach((n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "count-tab";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(+n === state.players));
      b.setAttribute("aria-label", `${n} players`);
      b.textContent = n;
      b.addEventListener("click", () => selectPlayers(+n));
      el.countTabs.appendChild(b);
    });
    const [g, e] = TEAMS[state.players];
    el.teams.innerHTML =
      `<span class="t-good"><b>${g}</b> Good</span><span class="t-evil"><b>${e}</b> Evil</span>`;
  }

  function renderVariants() {
    el.variants.innerHTML = "";
    const [goodTotal, evilTotal] = TEAMS[state.players];
    VARIANTS[state.players].forEach((rs, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "variant";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(i === state.variant));

      const goodSpecial = rs.filter((r) => ROLES[r].team === "good").length;
      const evilSpecial = rs.length - goodSpecial;
      const servants = goodTotal - goodSpecial;
      const minions = evilTotal - evilSpecial;

      const chips = rs.map((r) => `<span class="chip ${ROLES[r].team}">${ROLES[r].name}</span>`).join("");
      const fillers =
        (servants > 0 ? `<span class="chip filler good">+${servants} ${seljak(servants, false)}</span>` : "") +
        (minions > 0 ? `<span class="chip filler evil">+${minions} ${seljak(minions, true)}</span>` : "");

      b.innerHTML = `<span class="variant-name">Option ${i + 1}</span><span class="chips">${chips}${fillers}</span>`;
      b.addEventListener("click", () => selectVariant(i));
      el.variants.appendChild(b);
    });
  }

  function renderGap() {
    el.gapSeg.innerHTML = "";
    GAPS.forEach((g) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(g === state.gap));
      b.textContent = g === 0 ? "Off" : `${g}s`;
      b.addEventListener("click", () => {
        state.gap = g;
        store.set("gapSeconds", g);
        renderGap();
      });
      el.gapSeg.appendChild(b);
    });
  }

  function selectPlayers(n) {
    if (isActive() || n === state.players) return;
    state.players = n;
    state.variant = Math.min(state.variant, VARIANTS[n].length - 1);
    store.set("players", n);
    store.set("variant", state.variant);
    applySetup();
  }

  function selectVariant(i) {
    if (isActive() || i === state.variant) return;
    state.variant = i;
    store.set("variant", i);
    applySetup();
  }

  function applySetup() {
    state.queue = buildQueue(roles());
    state.index = 0;
    if (state.status === "done") state.status = "idle";
    renderCountTabs();
    renderVariants();
    renderSegments();
    render();
  }

  // ---------- Player rendering ----------
  function renderSegments() {
    el.segments.innerHTML = "";
    const known = state.queue.every((s) => dur(s) > 0);
    state.queue.forEach((s) => {
      const seg = document.createElement("div");
      seg.className = "pseg";
      seg.style.flex = known ? `${dur(s)} 1 0` : "1 1 0";
      seg.innerHTML = `<div class="pseg-fill"></div>`;
      el.segments.appendChild(seg);
    });
  }

  function renderProgress() {
    const segs = el.segments.children;
    state.queue.forEach((s, i) => {
      let pct = 0;
      if (state.status === "done" || i < state.index) pct = 100;
      else if (i === state.index && (state.status === "playing" || state.status === "paused")) {
        const d = audio.duration || dur(s);
        pct = d ? Math.min(100, (audio.currentTime / d) * 100) : 0;
      }
      if (segs[i]) {
        segs[i].firstChild.style.width = pct + "%";
        segs[i].classList.toggle("is-current", isActive() && i === state.index);
      }
    });

    const total = totalDuration();
    const now = currentTime();
    el.timeElapsed.textContent = fmt(now);
    el.timeTotal.textContent = fmt(total);
    el.progress.setAttribute("aria-valuenow", total ? Math.round((now / total) * 100) : 0);

    if (state.status === "playing" || state.status === "paused") {
      const d = audio.duration || dur(state.queue[state.index]);
      el.timeStep.textContent = `Step ${state.index + 1}/${state.queue.length} · −${fmt(d - audio.currentTime)}`;
    } else if (state.status === "gap") {
      el.timeStep.textContent = `Next in ${state.gapLeft}s`;
    } else {
      el.timeStep.textContent = `${state.queue.length} steps`;
    }
  }

  function render() {
    const { status } = state;
    const step = state.queue[state.index];

    // Lock setup while a session is running
    el.setup.classList.toggle("is-locked", isActive());
    el.lockHint.hidden = !isActive();

    // Big button
    const btnMap = {
      idle:    ["i-play", "Play", "Play"],
      playing: ["i-pause", "Pause", "Pause"],
      paused:  ["i-play", "Resume", "Resume"],
      gap:     ["i-pause", "Pause", "Pause"],
      done:    ["i-restart", "Play again", "Play again"],
    };
    const [icon, caption, label] = btnMap[status];
    el.playIco.innerHTML = `<use href="#${icon}"/>`;
    el.playCaption.textContent = caption;
    el.playBtn.setAttribute("aria-label", label);
    el.playBtn.dataset.state = status;

    // Now-playing text
    if (status === "idle") {
      el.nowLabel.textContent = "Ready";
      el.nowTitle.textContent = "Gather around the table";
      el.nowDesc.innerHTML = "Press play when everyone is seated. The narrator will guide the night phase.";
    } else if (status === "done") {
      el.nowLabel.textContent = "The night is over";
      el.nowTitle.textContent = "Let the quest begin";
      el.nowDesc.innerHTML = "Narration finished. Press play again to repeat it from the start.";
    } else if (status === "gap") {
      el.nowLabel.textContent = `Up next · Step ${state.index + 1} of ${state.queue.length}`;
      el.nowTitle.textContent = step.title;
      el.nowDesc.innerHTML = `Starting in ${state.gapLeft}s…`;
    } else {
      el.nowLabel.textContent =
        `${status === "paused" ? "Paused · " : ""}Step ${state.index + 1} of ${state.queue.length}`;
      el.nowTitle.textContent = step.title;
      el.nowDesc.innerHTML = step.desc(roles());
    }

    // Controls
    el.stopBtn.disabled = status === "idle";
    el.restartBtn.disabled = status === "idle";

    renderProgress();
    updateMediaSession();
  }

  // ---------- Playback engine ----------
  function clearGap() {
    if (gapTimer) { clearInterval(gapTimer); gapTimer = null; }
  }

  function loadStep(i, offset = 0) {
    const step = state.queue[i];
    state.index = i;
    const src = AUDIO_DIR + step.file;
    if (!audio.src.endsWith(src)) {
      audio.src = src;
      audio.load();
    }
    if (offset > 0) {
      if (audio.readyState >= 1) audio.currentTime = offset;
      else audio.addEventListener("loadedmetadata", () => { audio.currentTime = offset; }, { once: true });
    } else if (audio.readyState >= 1) {
      audio.currentTime = 0;
    }
  }

  async function playCurrent() {
    hideError();
    try {
      await audio.play();
      state.status = "playing";
      requestWakeLock();
      startTicker();
    } catch (err) {
      if (err && err.name === "AbortError") return; // superseded by another load
      state.status = "paused";
      showError(`Could not play “${state.queue[state.index].file}”. ${err && err.name === "NotAllowedError" ? "Tap Resume to continue." : ""}`);
    }
    render();
  }

  function start(fromIndex = 0, offset = 0) {
    clearGap();
    loadStep(fromIndex, offset);
    state.status = "playing";
    render();
    playCurrent();
  }

  function pause() {
    if (state.status === "gap") {
      // Pausing during the gap parks us at the start of the next step
      clearGap();
      loadStep(state.index, 0);
    } else {
      audio.pause();
    }
    state.status = "paused";
    stopTicker();
    releaseWakeLock();
    render();
  }

  function resume() {
    state.status = "playing";
    render();
    playCurrent();
  }

  function stop() {
    clearGap();
    audio.pause();
    stopTicker();
    releaseWakeLock();
    state.status = "idle";
    state.index = 0;
    try { audio.currentTime = 0; } catch { /* ignore */ }
    hideError();
    render();
  }

  function finish() {
    clearGap();
    stopTicker();
    releaseWakeLock();
    state.status = "done";
    render();
  }

  /** Move to step i. Keeps playing if we were playing; stays paused if paused. */
  function jumpTo(i, offset = 0) {
    if (i < 0) i = 0;
    if (i >= state.queue.length) return finish();
    const wasPaused = state.status === "paused";
    if (wasPaused) {
      audio.pause();
      loadStep(i, offset);
      state.status = "paused";
      render();
    } else {
      start(i, offset);
    }
  }

  function restart() {
    start(0);
  }

  function onEnded() {
    const nextIndex = state.index + 1;
    if (nextIndex >= state.queue.length) return finish();
    if (state.gap === 0) return start(nextIndex);
    state.status = "gap";
    state.index = nextIndex;
    state.gapLeft = state.gap;
    stopTicker();
    render();
    gapTimer = setInterval(() => {
      state.gapLeft -= 1;
      if (state.gapLeft <= 0) start(nextIndex);
      else render();
    }, 1000);
  }

  function togglePlay() {
    switch (state.status) {
      case "idle": return start(0);
      case "playing":
      case "gap": return pause();
      case "paused": return resume();
      case "done": return restart();
    }
  }

  // Smooth progress updates while playing
  function startTicker() {
    stopTicker();
    const tick = () => { renderProgress(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
  }
  function stopTicker() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // ---------- Seeking on the progress bar ----------
  function seekFromPointer(clientX) {
    if (!isActive() && state.status !== "done") return;
    const total = totalDuration();
    if (!total) return;
    const segs = [...el.segments.children];
    // Find which segment was hit, so the gaps between segments don't skew things
    for (let i = 0; i < segs.length; i++) {
      const r = segs[i].getBoundingClientRect();
      const last = i === segs.length - 1;
      if (clientX <= r.right + 2 || last) {
        const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        const offset = frac * dur(state.queue[i]);
        if (state.status === "done") { start(i, offset); return; }
        if (i === state.index && state.status !== "gap") {
          audio.currentTime = offset;
          renderProgress();
        } else {
          jumpTo(i, offset);
        }
        return;
      }
    }
  }

  el.progress.addEventListener("pointerdown", (e) => {
    seekFromPointer(e.clientX);
    const move = (ev) => seekFromPointer(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  el.progress.addEventListener("keydown", (e) => {
    if (state.status !== "playing" && state.status !== "paused") return;
    if (e.key === "ArrowRight") { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); e.preventDefault(); }
    if (e.key === "ArrowLeft") { audio.currentTime = Math.max(0, audio.currentTime - 5); e.preventDefault(); }
    renderProgress();
  });

  // ---------- Errors ----------
  function showError(msg) { el.error.textContent = msg; el.error.hidden = false; }
  function hideError() { el.error.hidden = true; }

  audio.addEventListener("ended", onEnded);
  audio.addEventListener("timeupdate", () => { if (state.status === "paused") renderProgress(); });
  audio.addEventListener("loadedmetadata", () => {
    const step = state.queue[state.index];
    if (step && isFinite(audio.duration) && !durations[step.file]) {
      durations[step.file] = audio.duration;
      renderSegments(); render();
    }
  });
  audio.addEventListener("error", () => {
    if (state.status === "idle") return;
    const step = state.queue[state.index];
    stopTicker();
    state.status = "paused";
    showError(`Audio file “${AUDIO_DIR}${step.file}” could not be loaded. Press Restart to try again.`);
    render();
  });

  // Probe all durations up front so the bar and total time are accurate
  function probeDurations() {
    Object.values(STEPS).forEach(({ file }) => {
      const a = new Audio();
      a.preload = "metadata";
      a.addEventListener("loadedmetadata", () => {
        if (isFinite(a.duration)) {
          durations[file] = a.duration;
          renderSegments(); render();
        }
      }, { once: true });
      a.src = AUDIO_DIR + file;
    });
  }

  // ---------- Wake lock (keep the phone screen on during narration) ----------
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch { /* not critical */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (state.status === "playing" || state.status === "gap")) requestWakeLock();
  });

  // ---------- Media Session (lock screen / headphone controls) ----------
  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const step = state.queue[state.index];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: isActive() && step ? step.title : "Avalon",
        artist: "Avalon · Luka Edition",
        album: `${state.players} players`,
      });
      navigator.mediaSession.playbackState =
        state.status === "playing" ? "playing" : state.status === "paused" ? "paused" : "none";
    } catch { /* ignore */ }
  }
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported */ } };
    set("play", () => (state.status === "paused" ? resume() : state.status === "idle" || state.status === "done" ? start(0) : null));
    set("pause", () => (state.status === "playing" || state.status === "gap") && pause());
    set("stop", stop);
  }

  // ---------- Wiring ----------
  el.playBtn.addEventListener("click", togglePlay);
  el.stopBtn.addEventListener("click", stop);
  el.restartBtn.addEventListener("click", restart);

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select")) return;
    if (e.code === "Space" && !e.target.closest("button")) { e.preventDefault(); togglePlay(); }
  });

  // ---------- Init ----------
  renderGap();
  applySetup();
  probeDurations();
})();
