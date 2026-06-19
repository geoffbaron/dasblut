// Spatial audio for DasBlut. Wraps Howler.js with camera-relative positioning
// so gunfire sounds louder and more directional the closer it is to screen center.
// Falls back to synthesized Web Audio tones if .ogg files aren't present yet —
// drop real files into public/sfx/ to replace them.

import { Howl, Howler } from "howler";

export type SfxId =
  | "rifle"
  | "smg"
  | "lmg"
  | "bazooka"
  | "panzerfaust"
  | "tank_ap"
  | "tank_mg"
  | "tank_he"
  | "explosion"
  | "ricochet"
  | "tank_hit"
  | "tank_destroy"
  | "soldier_hit"
  | "soldier_scream"
  | "suppress_shout"
  | "ui_select"
  | "ui_order"
  | "obj_capture"
  | "obj_lost"
  | "tank_engine"
  | "mortar";

// Maps each game event to one or more real audio files in public/sfx/ (filenames are
// the exact drop-in names, including extension — they're URL-encoded at load time so
// spaces/#/commas are fine). When several files are listed, one is chosen at random
// each play, which is how the German death-screams get their variety. An empty list
// means "no real file yet" → the synthesized fallback is used.
//
// Source files dropped in are a smaller set than the event list, so several events
// deliberately share a file (e.g. MG42 covers SMG/LMG/coax; the big design boom
// covers the tank cannon, AT launches and brew-ups).
const RIFLE = "GUNRif-Single_rifle_gunshot-Elevenlabs.mp3";
const MG42 = "WW2_MG42_machine_gun_#1-1781811071864.mp3";
const BIG_BOOM = "DSGNBoom-The_sound_of_a_singl-Elevenlabs.mp3";
const TANK_BOOM = "large_loud_WWII_tank_#4-1781811223525.mp3";
const GRENADE = "EXPLReal-grenade_explosion-Elevenlabs.mp3";
const MORTAR_FIRE = "WEAPSiege-mortar_firing_sound,-Elevenlabs.mp3";
const GASP = "GOREMisc-Soldier_dying_gasp,_-Elevenlabs.mp3";
const SCREAMS = [
  "dying_screaming_sayi_#1-1781820762926.mp3",
  "dying_screaming_sayi_#2-1781820762927.mp3",
  "dying_screaming_sayi_#3-1781820762927.mp3",
  "dying_screaming_sayi_#4-1781820762927.mp3",
];

const SFX_DEFS: Record<SfxId, { files: string[]; vol: number }> = {
  rifle:          { files: [RIFLE],     vol: 0.8 },
  smg:            { files: [MG42],      vol: 0.6 }, // no SMG sample — MG42 stands in
  lmg:            { files: [MG42],      vol: 0.9 },
  bazooka:        { files: [BIG_BOOM],  vol: 1.0 },
  panzerfaust:    { files: [BIG_BOOM],  vol: 1.0 },
  tank_ap:        { files: [BIG_BOOM],  vol: 1.0 },
  tank_mg:        { files: [MG42],      vol: 0.8 },
  tank_he:        { files: [TANK_BOOM], vol: 1.0 },
  explosion:      { files: [GRENADE],   vol: 1.0 },
  ricochet:       { files: [],          vol: 0.6 }, // synth fallback
  tank_hit:       { files: [TANK_BOOM], vol: 1.0 },
  tank_destroy:   { files: [BIG_BOOM],  vol: 1.0 },
  soldier_hit:    { files: [GASP],      vol: 0.8 },
  soldier_scream: { files: SCREAMS,     vol: 0.9 }, // 4 random German death-screams
  suppress_shout: { files: [],          vol: 0.5 }, // synth fallback
  ui_select:      { files: [],          vol: 0.4 }, // synth fallback
  ui_order:       { files: [],          vol: 0.4 }, // synth fallback
  obj_capture:    { files: [],          vol: 0.9 }, // synth fallback
  obj_lost:       { files: [],          vol: 0.9 }, // synth fallback
  tank_engine:    { files: [],          vol: 0.3 }, // synth fallback
  mortar:         { files: [MORTAR_FIRE], vol: 0.9 }, // tube thump when a mortar fires
};

// Maximum sounds per frame to avoid audio avalanche during heavy combat.
const MAX_PER_FRAME = 6;
// Distance in cells beyond which audio is inaudible.
const FADE_CELLS = 35;

export class SoundManager {
  // One Howl per variant file. Empty array → no real audio, use synth fallback.
  private howls = new Map<SfxId, Howl[]>();
  private synth: AudioContext | null = null;
  private frameCount = 0;
  private masterVol = 0.8;
  // World-space camera center, set each frame by the renderer.
  cameraX = 0;
  cameraY = 0;

  constructor() {
    Howler.volume(this.masterVol);
  }

  setMasterVolume(v: number) {
    this.masterVol = v;
    Howler.volume(v);
  }

  // Called each render frame to reset the per-frame throttle.
  tick() {
    this.frameCount = 0;
  }

  // Play a sound at world-cell coordinates. Distance from camera affects volume/pan.
  play(id: SfxId, worldX: number, worldY: number) {
    if (this.frameCount >= MAX_PER_FRAME) return;
    this.frameCount++;

    const dx = worldX - this.cameraX;
    const dy = worldY - this.cameraY;
    const dist = Math.hypot(dx, dy);
    if (dist > FADE_CELLS) return;

    const vol = (1 - dist / FADE_CELLS) ** 1.5;
    const pan = Math.max(-1, Math.min(1, dx / (FADE_CELLS * 0.5)));

    const howl = this.pickHowl(id);
    if (howl) {
      const sid = howl.play();
      howl.volume(SFX_DEFS[id].vol * vol, sid);
      howl.stereo(pan, sid);
    } else {
      this.playFallback(id, vol, pan);
    }
  }

  // Play a UI sound (not positional).
  playUI(id: SfxId) {
    const howl = this.pickHowl(id);
    if (howl) {
      const sid = howl.play();
      howl.volume(SFX_DEFS[id].vol, sid);
    } else {
      this.playFallback(id, 1, 0);
    }
  }

  // Lazily build a Howl per variant file, then return a random one (or null when the
  // id has no real files, so the caller drops to the synth fallback).
  private pickHowl(id: SfxId): Howl | null {
    let arr = this.howls.get(id);
    if (!arr) {
      const def = SFX_DEFS[id];
      arr = def.files.map(
        (name) =>
          new Howl({
            // Encode so spaces, '#', commas in the drop-in filenames survive the URL.
            src: [`/sfx/${encodeURIComponent(name)}`],
            volume: def.vol,
          }),
      );
      this.howls.set(id, arr);
    }
    if (arr.length === 0) return null;
    return arr[(Math.random() * arr.length) | 0];
  }

  // Synthesized Web Audio fallback so gameplay has audio before real files are added.
  private playFallback(id: SfxId, vol: number, pan: number) {
    if (!this.synth) {
      try { this.synth = new AudioContext(); } catch { return; }
    }
    const ctx = this.synth;
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    gain.gain.value = vol * 0.15; // quiet fallback
    gain.connect(panner);
    panner.connect(ctx.destination);

    const { freq, dur, type } = FALLBACK_PARAMS[id] ?? { freq: 200, dur: 0.1, type: "sawtooth" as OscillatorType };

    if (id === "explosion" || id === "tank_he" || id === "tank_destroy") {
      // Noise burst for explosions.
      const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      src.start();
    } else {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.3, ctx.currentTime + dur);
      gain.gain.setValueAtTime(vol * 0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.connect(gain);
      osc.start();
      osc.stop(ctx.currentTime + dur);
    }
  }
}

// Fallback synthesized sound parameters per ID.
const FALLBACK_PARAMS: Partial<Record<SfxId, { freq: number; dur: number; type: OscillatorType }>> = {
  rifle:          { freq: 800,  dur: 0.08, type: "sawtooth"  },
  smg:            { freq: 600,  dur: 0.06, type: "sawtooth"  },
  lmg:            { freq: 500,  dur: 0.10, type: "sawtooth"  },
  bazooka:        { freq: 300,  dur: 0.20, type: "sawtooth"  },
  panzerfaust:    { freq: 280,  dur: 0.20, type: "sawtooth"  },
  tank_ap:        { freq: 400,  dur: 0.25, type: "sawtooth"  },
  tank_mg:        { freq: 550,  dur: 0.08, type: "sawtooth"  },
  tank_he:        { freq: 100,  dur: 0.45, type: "sawtooth"  },
  explosion:      { freq: 80,   dur: 0.5,  type: "sawtooth"  },
  ricochet:       { freq: 1200, dur: 0.12, type: "sine"      },
  tank_hit:       { freq: 250,  dur: 0.30, type: "sawtooth"  },
  tank_destroy:   { freq: 120,  dur: 0.6,  type: "sawtooth"  },
  soldier_hit:    { freq: 300,  dur: 0.08, type: "triangle"  },
  soldier_scream: { freq: 500,  dur: 0.25, type: "sine"      },
  suppress_shout: { freq: 350,  dur: 0.15, type: "sine"      },
  ui_select:      { freq: 880,  dur: 0.05, type: "sine"      },
  ui_order:       { freq: 660,  dur: 0.07, type: "sine"      },
  obj_capture:    { freq: 523,  dur: 0.30, type: "sine"      },
  obj_lost:       { freq: 220,  dur: 0.40, type: "sine"      },
  tank_engine:    { freq: 80,   dur: 0.20, type: "sawtooth"  },
  mortar:         { freq: 150,  dur: 0.30, type: "sawtooth"  },
};

// Singleton — one manager for the whole game.
export const sound = new SoundManager();
