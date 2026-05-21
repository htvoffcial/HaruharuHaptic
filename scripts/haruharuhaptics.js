/*
  Haruharu Haptics
  - Find <audio hht-href="..."> elements
  - Fetch .hht (binary)
  - Schedule vibration pulses synced to currentTime

  Design goals:
  - low overhead for cheap phones
  - avoid "always on" buzz: pulse train with gaps + simple limiter
  - handle seek/pause/ratechange safely
*/

(function () {
  const LOOKAHEAD_MS = 350;  // schedule window
  const TICK_MS = 120;       // resync tick

  const MIN_GAP_MS = 18;     // gap between pulses (JS-side)
  const MIN_PULSE_MS = 12;
  const MAX_PULSE_MS = 60;

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function parseHHT(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    if (dv.byteLength < 16) throw new Error('HHT too small');

    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'HHT1') throw new Error('Bad HHT magic: ' + magic);

    const version = dv.getUint8(4);
    if (version !== 1) throw new Error('Unsupported HHT version: ' + version);

    const timebaseHz = dv.getUint32(8, true);
    const eventCount = dv.getUint32(12, true);

    const events = new Array(eventCount);
    let off = 16;
    for (let i = 0; i < eventCount; i++) {
      if (off + 8 > dv.byteLength) throw new Error('Truncated HHT events');
      const t = dv.getUint32(off + 0, true);
      const d = dv.getUint16(off + 4, true);
      const intensity = dv.getUint8(off + 6);
      const kind = dv.getUint8(off + 7);
      events[i] = { t, d, intensity, kind };
      off += 8;
    }
    return { version, timebaseHz, events };
  }

  function toMs(hht, tUnits) { return (tUnits * 1000) / hht.timebaseHz; }

  function createPulsePattern(intensityU8, durationMs) {
    // Pulse train: [on, off, on, off, ...]
    const pct = clamp(intensityU8, 0, 255) / 255;

    const pulseOn = clamp(Math.round(MIN_PULSE_MS + pct * 40), MIN_PULSE_MS, MAX_PULSE_MS);
    const gap = MIN_GAP_MS;

    const pulses = clamp(Math.round(1 + pct * 3), 1, 4);

    const pattern = [];
    let remaining = clamp(Math.round(durationMs), 0, 2000);
    for (let p = 0; p < pulses && remaining > 0; p++) {
      const on = clamp(pulseOn, 1, remaining);
      pattern.push(on);
      remaining -= on;
      if (remaining <= 0) break;
      const off = clamp(gap, 1, remaining);
      pattern.push(off);
      remaining -= off;
    }
    if (pattern.length === 0) return [MIN_PULSE_MS];
    return pattern;
  }

  function attach(audio) {
    const href = audio.getAttribute('hht-href');
    if (!href) return;

    const state = {
      hht: null,
      events: null,
      loaded: false,
      loadError: null,

      idxHint: 0,
      tickTimer: null,
      scheduled: new Set(),

      // simple limiter: don't call vibrate too frequently
      lastVibrateAt: 0,
      minVibrateIntervalMs: 35,
    };

    async function load() {
      if (state.loaded || state.loadError) return;
      try {
        const res = await fetch(href, { cache: 'force-cache' });
        if (!res.ok) throw new Error('Failed to fetch HHT: ' + res.status);
        const buf = await res.arrayBuffer();
        state.hht = parseHHT(buf);
        state.events = state.hht.events;
        state.loaded = true;
      } catch (e) {
        state.loadError = e;
        console.warn('[HaruharuHaptic] load error', e);
      }
    }

    function clearScheduled() {
      for (const id of state.scheduled) clearTimeout(id);
      state.scheduled.clear();
      if (navigator.vibrate) navigator.vibrate(0);
    }

    function audioTimeMs() { return audio.currentTime * 1000; }

    function findStartIndex(tMs) {
      const ev = state.events;
      let i = clamp(state.idxHint || 0, 0, ev.length);

      // detect seek backwards -> reset
      if (i > 0) {
        const prevMs = toMs(state.hht, ev[i - 1].t);
        if (prevMs > tMs + 250) i = 0;
      }

      while (i < ev.length) {
        const eMs = toMs(state.hht, ev[i].t);
        if (eMs >= tMs) break;
        i++;
      }
      return i;
    }

    function scheduleWindow() {
      if (!state.loaded || !state.events) return;
      if (audio.paused || audio.ended) return;
      if (!navigator.vibrate) return;

      const t0Audio = audioTimeMs();
      const t0Wall = nowMs();

      let i = findStartIndex(t0Audio);
      state.idxHint = i;

      const ev = state.events;
      while (i < ev.length) {
        const e = ev[i];
        if (e.kind !== 0) { i++; continue; }

        const eStartMs = toMs(state.hht, e.t);
        const dtAudio = eStartMs - t0Audio;
        if (dtAudio > LOOKAHEAD_MS) break;
        if (dtAudio < -40) { i++; continue; }

        const rate = audio.playbackRate || 1.0;
        const dtWall = dtAudio / rate;
        const fireIn = Math.max(0, Math.round(dtWall));

        const durationMs = toMs(state.hht, e.d);
        const intensity = e.intensity;

        const id = setTimeout(() => {
          state.scheduled.delete(id);
          if (audio.paused || audio.ended) return;

          const w = nowMs();
          if (w - state.lastVibrateAt < state.minVibrateIntervalMs) return;
          state.lastVibrateAt = w;

          const pattern = createPulsePattern(intensity, durationMs);
          try { navigator.vibrate(pattern); } catch (_) {}
        }, fireIn);

        state.scheduled.add(id);
        i++;
      }

      state.idxHint = i;
    }

    function startTick() {
      if (state.tickTimer) return;
      state.tickTimer = setInterval(scheduleWindow, TICK_MS);
    }
    function stopTick() {
      if (state.tickTimer) clearInterval(state.tickTimer);
      state.tickTimer = null;
    }

    audio.addEventListener('play', async () => {
      await load();
      clearScheduled();
      scheduleWindow();
      startTick();
    });
    audio.addEventListener('pause', () => { stopTick(); clearScheduled(); });
    audio.addEventListener('ended', () => { stopTick(); clearScheduled(); });
    audio.addEventListener('seeking', () => { clearScheduled(); });
    audio.addEventListener('seeked', () => {
      if (!state.loaded) return;
      state.idxHint = findStartIndex(audioTimeMs());
      scheduleWindow();
    });
    audio.addEventListener('ratechange', () => { clearScheduled(); scheduleWindow(); });

    // best-effort preload
    load();
  }

  function boot() {
    document.querySelectorAll('audio[hht-href]').forEach(attach);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
