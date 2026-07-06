// Spatial audio for Any War. Wraps Howler.js with camera-relative positioning
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
  | "soldier_scream_us"
  | "suppress_shout"
  | "ui_select"
  | "ui_order"
  | "obj_capture"
  | "obj_lost"
  | "tank_engine"
  | "ambient"
  | "mortar"
  | "riflemusket"
  | "carbine"
  | "cannon"
  | "melee"
  | "horse"
  | "bow"
  | "catapult"
  | "boulder"
  | "warhorn"
  | "med_ambient"
  | "melee_med"
  | "warcry"
  | "arrow_hit"
  | "blaster"
  | "heavyblaster"
  | "rocket";

// Maps each game event to one or more real audio files in public/sfx/ (filenames are
// the exact drop-in names, including extension — they're URL-encoded at load time so
// spaces/#/commas are fine). When several files are listed, one is chosen at random
// each play, which is how the German death-screams get their variety. An empty list
// means "no real file yet" → the synthesized fallback is used.
//
// Source files dropped in are a smaller set than the event list, so several events
// deliberately share a file (e.g. MG42 covers SMG/LMG/coax; the big design boom
// covers the tank cannon, AT launches and brew-ups).
// NOTE: filenames must not contain '#'. A '#' (even URL-encoded as %23) gets decoded
// to a fragment by the static server and the file is served truncated → fails to
// decode → silent. The '#'-named drop-ins were renamed to plain numbers.
const RIFLE = "GUNRif-Single_rifle_gunshot-Elevenlabs.mp3";
const MG42 = "WW2_MG42_machine_gun_1-1781811071864.mp3";
const BIG_BOOM = "DSGNBoom-The_sound_of_a_singl-Elevenlabs.mp3";
const TANK_BOOM = "large_loud_WWII_tank_4-1781811223525.mp3";
const GRENADE = "EXPLReal-grenade_explosion-Elevenlabs.mp3";
const MORTAR_FIRE = "WEAPSiege-mortar_firing_sound,-Elevenlabs.mp3";
const GASP = "GOREMisc-Soldier_dying_gasp,_-Elevenlabs.mp3";
const BAZOOKA_BLAST = "EXPLReal-bazooka_blast-Elevenlabs.mp3";
// American Civil War — generated on ElevenLabs (period black-powder arms + sabre).
// Two takes of each so volleys, batteries and melees don't sound like one looped clip.
const ACW_MUSKET = "acw_musket.mp3";
const ACW_MUSKET2 = "acw_musket2.mp3";
const ACW_CARBINE = "acw_carbine.mp3";
const ACW_CARBINE2 = "acw_carbine2.mp3";
const ACW_CANNON = "acw_cannon.mp3";
const ACW_CANNON2 = "acw_cannon2.mp3";
const ACW_SABRE = "acw_sabre.mp3";
const ACW_SABRE2 = "acw_sabre2.mp3";
// Extra hand-to-hand takes — melee lasts several exchanges now, so a fat pool of
// bayonet clashes, sabre strikes and grappling grunts keeps a long scrum from looping.
const ACW_MELEE_BAYONET1 = "acw_melee_bayonet1.mp3";
const ACW_MELEE_BAYONET2 = "acw_melee_bayonet2.mp3";
const ACW_MELEE_SABRE2 = "acw_melee_sabre2.mp3";
const ACW_MELEE_STRUGGLE = "acw_melee_struggle.mp3";
const ACW_SHELL = "acw_shell.mp3"; // shell burst — thrown into the generic explosion pool
// Cavalry horses — galloping hooves as they charge home, plus a whinny for the ambient bed.
const HORSE_GALLOP = "horse_gallop.mp3";
const HORSE_WHINNY = "horse_whinny.mp3";
// Medieval — generated on ElevenLabs. Archers loose a hail of arrows; a catapult creaks and
// releases; the stone comes down with a bone-breaking crash; a horn calls across the field.
const MED_ARROW = "med_arrow.mp3";
const MED_ARROW_VOLLEY = "med_arrow_volley.mp3";
const MED_CATAPULT = "med_catapult.mp3";
const MED_BOULDER = "med_boulder.mp3";
const MED_WARHORN = "med_warhorn.mp3";
const MED_AMBIENT = "med_ambient.mp3";
// Medieval close-combat set: period sword-on-shield / on-armour clashes and an armoured
// grapple for the melee pool, a mass battle-cry for charges, and an arrow-impact thud.
const MED_SWORD_SHIELD = "med_sword_shield.mp3";
const MED_SWORD_ARMOR = "med_sword_armor.mp3";
const MED_MELEE_STRUGGLE = "med_melee_struggle.mp3";
const MED_WARCRY = "med_warcry.mp3";
const MED_ARROW_HIT = "med_arrow_hit.mp3";
const SWITCH = "UIMvmt-puzzle_UI_tab_switch-Elevenlabs.mp3"; // UI select/order click
// Generic, non-verbal death cries, played when any soldier is killed. (The old German
// voice screams were removed — they were jarring and wrong for the Civil War.) Several
// takes so a volley's worth of men falling doesn't sound like one repeated cry.
const SCREAM_US = "HMNMisc-A_male_soldier_screa-Elevenlabs.mp3";
const SCREAM1 = "scream1.mp3";
const SCREAM2 = "scream2.mp3";
// Tank engine — looped continuously while a tank is on the move.
const TANK_DRIVE = [
  "VEHMil-tank_driving-Elevenlabs.mp3",
];
// Distant battlefield atmosphere — planes, far-off small-arms, general battle din.
// Played at low volume on a slow random timer so the field never feels empty.
const AMBIENT = [
  "AEROMil-WW2_planes_in_distan-Elevenlabs.mp3",
  "GUNRif-distant_small_arms_f-Elevenlabs.mp3",
  "GUNRif-distant_small_arms_f-Elevenlabs (1).mp3",
  "ambient_battle_dista_1-1781828842109.mp3",
];

const SFX_DEFS: Record<SfxId, { files: string[]; vol: number }> = {
  rifle:          { files: [RIFLE],     vol: 0.8 },
  smg:            { files: [MG42],      vol: 0.6 }, // no SMG sample — MG42 stands in
  lmg:            { files: [MG42],      vol: 0.9 },
  bazooka:        { files: [BAZOOKA_BLAST], vol: 1.0 },
  panzerfaust:    { files: [BAZOOKA_BLAST], vol: 1.0 },
  tank_ap:        { files: [BIG_BOOM],  vol: 1.0 },
  tank_mg:        { files: [MG42],      vol: 0.8 },
  tank_he:        { files: [TANK_BOOM], vol: 1.0 },
  explosion:      { files: [GRENADE, ACW_SHELL], vol: 1.0 }, // grenade + a shell burst for variety
  ricochet:       { files: [],          vol: 0.6 }, // synth fallback (zing)
  tank_hit:       { files: [TANK_BOOM], vol: 1.0 },
  tank_destroy:   { files: [BIG_BOOM],  vol: 1.0 },
  soldier_hit:    { files: [GASP],      vol: 0.85 },
  soldier_scream:    { files: [SCREAM_US, SCREAM1, SCREAM2], vol: 0.95 }, // generic death cries (no German voice)
  soldier_scream_us: { files: [SCREAM_US, SCREAM1, SCREAM2], vol: 0.95 }, // US death screams
  suppress_shout: { files: [],          vol: 0.5 }, // synth fallback
  ui_select:      { files: [SWITCH],    vol: 0.5 }, // switch-flip click (selection only)
  ui_order:       { files: [],          vol: 0.0 }, // silent — no click on every order
  obj_capture:    { files: [],          vol: 0.9 }, // synth fallback
  obj_lost:       { files: [],          vol: 0.9 }, // synth fallback
  tank_engine:    { files: TANK_DRIVE,  vol: 0.45 }, // looped while a tank drives
  ambient:        { files: AMBIENT,     vol: 0.3 },  // low distant battlefield bed
  mortar:         { files: [MORTAR_FIRE], vol: 0.9 }, // tube thump when a mortar fires
  // American Civil War — period samples generated on ElevenLabs (two takes each for variety).
  riflemusket:    { files: [ACW_MUSKET, ACW_MUSKET2],   vol: 0.9 }, // single black-powder report
  carbine:        { files: [ACW_CARBINE, ACW_CARBINE2], vol: 0.8 },
  cannon:         { files: [ACW_CANNON, ACW_CANNON2],   vol: 1.0 }, // field-gun discharge
  melee:          { files: [ACW_SABRE, ACW_SABRE2, ACW_MELEE_BAYONET1, ACW_MELEE_BAYONET2, ACW_MELEE_SABRE2, ACW_MELEE_STRUGGLE], vol: 0.7 }, // sabre/bayonet/sword clash
  horse:          { files: [HORSE_GALLOP, HORSE_WHINNY], vol: 0.6 }, // cavalry & knight hooves
  // Medieval — samples generated on ElevenLabs.
  bow:            { files: [MED_ARROW, MED_ARROW_VOLLEY], vol: 0.7 }, // an arrow / hail of arrows loosed
  catapult:       { files: [MED_CATAPULT], vol: 0.95 }, // the throwing arm's release
  boulder:        { files: [MED_BOULDER],  vol: 1.0 },  // the stone crashing down
  warhorn:        { files: [MED_WARHORN],  vol: 0.5 },  // distant horn call in the ambient bed
  med_ambient:    { files: [MED_AMBIENT],  vol: 0.3 },  // faint clash of a battle beyond sight
  melee_med:      { files: [MED_SWORD_SHIELD, MED_SWORD_ARMOR, MED_MELEE_STRUGGLE], vol: 0.7 }, // sword on shield/armour
  warcry:         { files: [MED_WARCRY],   vol: 0.6 },  // a mass roar as men charge home
  arrow_hit:      { files: [MED_ARROW_HIT], vol: 0.55 }, // shafts thudding into shields/flesh
  // Star Wars — no real samples yet; the synth fallback's square-wave pew reads laser
  // enough until files are dropped in. The rocket reuses the bazooka blast.
  blaster:        { files: [],              vol: 0.7 },
  heavyblaster:   { files: [],              vol: 0.8 },
  rocket:         { files: [BAZOOKA_BLAST], vol: 1.0 },
};

// Maximum audible sounds per frame to avoid an audio avalanche during heavy combat.
const MAX_PER_FRAME = 10;
// Priority sounds (deaths/screams) get their own reserved budget so the constant
// chatter of gunfire can never starve them — being able to hear men fall (and which
// side fell) matters. Generous because simultaneous deaths are rare.
const MAX_PRIORITY_PER_FRAME = 8;
// Distance in cells beyond which audio is inaudible.
const FADE_CELLS = 35;

export class SoundManager {
  // One Howl per variant file. Empty array → no real audio, use synth fallback.
  private howls = new Map<SfxId, Howl[]>();
  private synth: AudioContext | null = null;
  private frameCount = 0;
  private priorityCount = 0;
  private masterVol = 0.8;
  // World-space camera center, set each frame by the renderer.
  cameraX = 0;
  cameraY = 0;
  // Sustained engine loops, keyed by vehicle id (started/stopped as tanks move).
  private engines = new Map<number, { howl: Howl; sid: number }>();
  // Seconds until the next random distant-ambience cue.
  private ambientTimer = 6;
  // The era picks the ambient bed: WW2 = planes & far-off small arms; the Civil War = faint
  // musketry and gunnery; the medieval field = a distant din of steel, horns and hooves;
  // Star Wars reuses the WW2 battle-din bed. Set from main.ts when a battle starts.
  era: "ww2" | "acw" | "medieval" | "starwars" = "ww2";

  constructor() {
    Howler.volume(this.masterVol);
  }

  setMasterVolume(v: number) {
    this.masterVol = v;
    Howler.volume(v);
  }

  // Mute everything at once (used while the game is paused) — silences looping
  // engines and ambience too, which one-shot throttling can't reach.
  setMuted(m: boolean) {
    Howler.mute(m);
  }

  // Called each render frame to reset the per-frame throttles.
  tick() {
    this.frameCount = 0;
    this.priorityCount = 0;
  }

  // Play a sound at world-cell coordinates. Distance from camera affects volume/pan.
  // `priority` events (deaths/screams) draw from a separate reserved budget so they
  // are never crowded out by routine gunfire.
  play(id: SfxId, worldX: number, worldY: number, priority = false) {
    // Cull out-of-earshot sounds BEFORE spending the per-frame budget, otherwise a
    // burst of distant gunfire silently eats the budget and starves the close-up
    // shots the player is actually watching.
    const dx = worldX - this.cameraX;
    const dy = worldY - this.cameraY;
    const dist = Math.hypot(dx, dy);
    if (dist > FADE_CELLS) return;

    if (priority) {
      if (this.priorityCount >= MAX_PRIORITY_PER_FRAME) return;
      this.priorityCount++;
    } else {
      if (this.frameCount >= MAX_PER_FRAME) return;
      this.frameCount++;
    }

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

  // Start/maintain/stop a looping engine sound for a vehicle. Call every step with
  // whether the tank is currently moving; volume and pan track the camera so the
  // engine swells as you watch it and fades as it drives off.
  setEngine(vehId: number, moving: boolean, worldX: number, worldY: number) {
    const cur = this.engines.get(vehId);
    if (!moving) {
      if (cur) {
        cur.howl.stop(cur.sid);
        this.engines.delete(vehId);
      }
      return;
    }
    const dx = worldX - this.cameraX;
    const dy = worldY - this.cameraY;
    const dist = Math.hypot(dx, dy);
    const vol = dist > FADE_CELLS ? 0 : (1 - dist / FADE_CELLS) ** 1.5;
    const pan = Math.max(-1, Math.min(1, dx / (FADE_CELLS * 0.5)));
    if (!cur) {
      const howl = this.pickHowl("tank_engine");
      if (!howl) return; // no engine files → stay silent (no synth loop)
      const sid = howl.play();
      howl.loop(true, sid);
      howl.volume(SFX_DEFS.tank_engine.vol * vol, sid);
      howl.stereo(pan, sid);
      this.engines.set(vehId, { howl, sid });
    } else {
      cur.howl.volume(SFX_DEFS.tank_engine.vol * vol, cur.sid);
      cur.howl.stereo(pan, cur.sid);
    }
  }

  // Slow random scheduler for distant battlefield ambience. Call once per rendered
  // frame with the elapsed seconds; only fires while a battle is actually underway.
  updateAmbient(dtSec: number, active: boolean) {
    if (!active) return;
    this.ambientTimer -= dtSec;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = 14 + Math.random() * 16; // next cue in 14–30s
    // Civil War: no aircraft or modern small-arms bed — instead a faint, far-off din of
    // black-powder volley fire and the occasional gun, built from the period samples.
    if (this.era === "acw") {
      // Mostly far-off musketry, some gunnery, and now and then a horse off in the field.
      const r = Math.random();
      const id: SfxId = r < 0.62 ? "riflemusket" : r < 0.85 ? "cannon" : "horse";
      const howl = this.pickHowl(id);
      if (!howl) return;
      const sid = howl.play();
      howl.volume(id === "horse" ? 0.2 : 0.16, sid); // distant
      howl.stereo((Math.random() * 2 - 1) * 0.75, sid);
      return;
    }
    // Medieval: a far-off din of a battle beyond sight — mostly the clash of a distant
    // engagement, with a horn call, a hail of arrows or hooves drifting across now and then.
    if (this.era === "medieval") {
      const r = Math.random();
      const id: SfxId = r < 0.44 ? "med_ambient" : r < 0.6 ? "melee_med" : r < 0.74 ? "warhorn" : r < 0.85 ? "warcry" : r < 0.94 ? "bow" : "horse";
      const howl = this.pickHowl(id);
      if (!howl) return;
      const sid = howl.play();
      howl.volume(id === "med_ambient" ? 0.24 : id === "warhorn" || id === "warcry" ? 0.22 : 0.16, sid); // distant
      howl.stereo((Math.random() * 2 - 1) * 0.75, sid);
      return;
    }
    const howl = this.pickHowl("ambient");
    if (!howl) return;
    const sid = howl.play();
    howl.volume(SFX_DEFS.ambient.vol, sid);
    howl.stereo((Math.random() * 2 - 1) * 0.6, sid); // spread it around the field
  }

  // Play a UI sound (not positional).
  playUI(id: SfxId) {
    if (SFX_DEFS[id].vol <= 0) return; // vol 0 = intentionally silent (e.g. ui_order) — no synth fallback either
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
  // Wrapped so a missing/closed AudioContext can never throw into the sim loop — a
  // synth-only positional cue (e.g. ricochet) must fail silently, not break a step.
  private playFallback(id: SfxId, vol: number, pan: number) {
    try {
      if (!this.synth || this.synth.state === "closed") {
        this.synth = new AudioContext();
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
    } catch {
      // Audio context unavailable (e.g. backgrounded tab) — stay silent.
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
  soldier_scream_us: { freq: 460, dur: 0.25, type: "sine"   },
  suppress_shout: { freq: 350,  dur: 0.15, type: "sine"      },
  ui_select:      { freq: 880,  dur: 0.05, type: "sine"      },
  ui_order:       { freq: 660,  dur: 0.07, type: "sine"      },
  obj_capture:    { freq: 523,  dur: 0.30, type: "sine"      },
  obj_lost:       { freq: 220,  dur: 0.40, type: "sine"      },
  tank_engine:    { freq: 80,   dur: 0.20, type: "sawtooth"  },
  mortar:         { freq: 150,  dur: 0.30, type: "sawtooth"  },
  horse:          { freq: 260,  dur: 0.30, type: "sawtooth"  },
  // Laser pews: a high square wave with the standard downward sweep.
  blaster:        { freq: 1400, dur: 0.09, type: "square"    },
  heavyblaster:   { freq: 1100, dur: 0.07, type: "square"    },
  rocket:         { freq: 300,  dur: 0.20, type: "sawtooth"  },
};

// Singleton — one manager for the whole game.
export const sound = new SoundManager();
