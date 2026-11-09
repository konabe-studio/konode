// Cuts the captured frames into the finished video.
//
//   node scripts/promo/assemble.mjs --lang=en
//
// Shot lengths are fixed by scripts/promo/kinetic (and by the frame budgets of the
// product shots), so every language is the same film with the same cuts. Only the words
// change. That is also why the voice-over is one file per shot rather than one long
// track: a Hungarian sentence that runs two seconds longer than its English counterpart
// has to be caught here, not discovered in the edit.
//
// Audio is optional. Without it you get the silent cut, which is enough to judge timing.
//
//   promo-out/<lang>/audio/shot-4.mp3   voice-over for shot 4, generated elsewhere
//   promo-out/<lang>/audio/music.mp3    one bed under the whole thing
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORDER = [1, 2, 3, 4, 5, 6, 7, 8];
const MUSIC_GAIN = 0.12;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);

const lang = args.lang ?? "en";
const fps = Number(args.fps ?? 30);
const base = resolve(ROOT, args.out ?? "promo-out", lang);
const work = resolve(base, "segments");

function ffmpeg(params) {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...params], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${params.join(" ")}`);
}

function seconds(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ], { encoding: "utf8" });
  return Number(out.trim());
}

function requireFfmpeg() {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const res = spawnSync(tool, ["-version"], { stdio: "ignore" });
    if (res.error) {
      console.error(`\n  ${tool} is not installed, and it is the part that does the cutting.\n`);
      console.error("    sudo apt install ffmpeg\n");
      process.exit(1);
    }
  }
}

function audioFor(shot) {
  for (const ext of ["mp3", "m4a", "wav", "ogg"]) {
    const file = resolve(base, "audio", `shot-${shot}.${ext}`);
    if (existsSync(file)) return file;
  }
  return null;
}

function musicFile() {
  for (const ext of ["mp3", "m4a", "wav", "ogg"]) {
    const file = resolve(base, "audio", `music.${ext}`);
    if (existsSync(file)) return file;
  }
  return null;
}

async function main() {
  requireFfmpeg();
  await mkdir(work, { recursive: true });

  const shots = ORDER.filter((n) => {
    const dir = resolve(base, `shot-${n}`);
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".png"));
  });
  if (!shots.length) throw new Error(`no captured frames under ${base}. Run capture.mjs first.`);
  const missing = ORDER.filter((n) => !shots.includes(n));
  if (missing.length) console.log(`  cutting without shot${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);

  // One segment per shot, each already at the master's size so the concat has nothing
  // left to decide.
  const starts = {};
  let clock = 0;
  for (const shot of shots) {
    const dir = resolve(base, `shot-${shot}`);
    const out = resolve(work, `shot-${shot}.mp4`);
    ffmpeg([
      "-framerate", String(fps),
      "-i", resolve(dir, "frame-%05d.png"),
      "-vf", "scale=1920:1080:flags=lanczos",
      "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
      out,
    ]);
    starts[shot] = clock;
    clock += seconds(out);
    console.log(`  shot ${shot}: ${seconds(out).toFixed(2)}s`);
  }

  const list = resolve(work, "concat.txt");
  execFileSync("sh", ["-c", `: > ${JSON.stringify(list)}`]);
  for (const shot of shots) {
    execFileSync("sh", ["-c",
      `printf 'file %s\\n' ${JSON.stringify(resolve(work, `shot-${shot}.mp4`))} >> ${JSON.stringify(list)}`]);
  }
  const silent = resolve(work, "silent.mp4");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);
  console.log(`  cut: ${clock.toFixed(2)}s total`);

  // Voice-over, each line pinned to the start of the shot it belongs to.
  const voices = shots.map((shot) => ({ shot, file: audioFor(shot) })).filter((v) => v.file);
  const music = musicFile();
  const master = resolve(base, `konode-promo-${lang}.mp4`);

  if (!voices.length && !music) {
    ffmpeg(["-i", silent, "-c", "copy", master]);
    console.log("  no audio found, silent cut only");
  } else {
    const inputs = ["-i", silent];
    const filters = [];
    const mixed = [];
    voices.forEach((v, i) => {
      const length = seconds(v.file);
      const room = (shots.includes(v.shot + 1) ? starts[v.shot + 1] : clock) - starts[v.shot];
      if (length > room + 0.25) {
        console.warn(`  !  shot ${v.shot}: the ${lang} line runs ${length.toFixed(1)}s in a ${room.toFixed(1)}s shot.`);
        console.warn("     Shorten the line or slow the shot, but change it for every language or the cuts drift apart.");
      }
      inputs.push("-i", v.file);
      const delay = Math.round(starts[v.shot] * 1000);
      filters.push(`[${i + 1}:a]adelay=${delay}|${delay}[v${i}]`);
      mixed.push(`[v${i}]`);
    });
    if (music) {
      inputs.push("-i", music);
      const idx = voices.length + 1;
      filters.push(`[${idx}:a]volume=${MUSIC_GAIN},atrim=0:${clock},afade=t=out:st=${Math.max(0, clock - 1.5)}:d=1.5[bed]`);
      mixed.push("[bed]");
    }
    filters.push(`${mixed.join("")}amix=inputs=${mixed.length}:normalize=0:duration=longest[a]`);
    ffmpeg([
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
      master,
    ]);
  }

  // Product Hunt wants a gallery-sized file and a still, and they should come out of the
  // same master so they cannot disagree with it.
  const ph = resolve(base, `konode-promo-${lang}-1270.mp4`);
  ffmpeg(["-i", master, "-vf", "scale=1270:714:flags=lanczos", "-c:v", "libx264", "-crf", "20",
    "-pix_fmt", "yuv420p", "-an", ph]);
  const poster = resolve(base, `konode-promo-${lang}-poster.png`);
  ffmpeg(["-i", master, "-ss", String(Math.min(clock - 0.5, (starts[3] ?? 0) + 4.2)),
    "-frames:v", "1", "-vf", "scale=1270:714:flags=lanczos", poster]);

  console.log(`\n  ${master}\n  ${ph}\n  ${poster}`);
}

await main();
