'use client';

/** 긴급 경보음 (Web Audio, 파일 불필요). 브라우저 정책상 사용자가 한 번 클릭한 뒤에야 소리가 난다. */
let ctx: AudioContext | null = null;

export function unlockAudio(): boolean {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

export function audioReady(): boolean {
  return !!ctx && ctx.state === 'running';
}

/** 높낮이가 번갈아 울리는 사이렌 약 2.4초 */
export function siren() {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  for (let i = 0; i < 6; i++) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = i % 2 ? 660 : 990;
    g.gain.setValueAtTime(0.15, t0 + i * 0.4);
    g.gain.setValueAtTime(0.0001, t0 + i * 0.4 + 0.38);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t0 + i * 0.4);
    o.stop(t0 + i * 0.4 + 0.4);
  }
}
