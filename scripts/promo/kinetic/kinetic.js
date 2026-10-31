// The kinetic shots of the promo video.
//
// Nothing here animates on its own. The page renders the instant it is asked for, and
// the capture script walks the timeline frame by frame, so a slow machine, a busy
// machine and a re-shoot eighteen months from now all produce identical frames. That is
// the whole reason this is hand-rolled instead of CSS animations, which cannot be seeked.
//
//   await window.__load("hu", 3)   build shot 3 with Hungarian text, returns its length
//   window.__seek(1240)            render the frame at 1.24s
//
// Open it by hand while designing: /kinetic/?lang=en&shot=3&t=1240

const DURATION = { 1: 5000, 2: 7000, 3: 6000, 7: 8000, 8: 6000 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const at = (t, start, dur) => clamp((t - start) / dur, 0, 1);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, p) => a + (b - a) * p;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function rise(node, progress, dy = 20) {
  const e = easeOut(progress);
  node.style.opacity = String(e);
  node.style.transform = `translateY(${(1 - e) * dy}px)`;
}

// #52525b to #6ee7b7, the wire going from dead grey to live mint.
function wireColour(progress) {
  const e = easeInOut(progress);
  const r = Math.round(lerp(0x52, 0x6e, e));
  const g = Math.round(lerp(0x52, 0xe7, e));
  const b = Math.round(lerp(0x5b, 0xb7, e));
  return `rgb(${r}, ${g}, ${b})`;
}

// The shipped wordmark, recoloured for a dark stage. Keeping the real file means the
// video cannot drift from the product the way a redrawn logo would.
async function wordmarkNode() {
  const svg = await (await fetch("/icons/wordmark.svg")).text();
  const node = el("div", "wordmark");
  node.innerHTML = svg.replaceAll("#11151a", "#f4f4f5");
  return node;
}

function rail(hubText) {
  const wrap = el("div", "rail");
  const left = el("div", "dev");
  const wireA = el("div", "wire");
  const hub = el("div", "hub", hubText);
  const wireB = el("div", "wire right");
  const right = el("div", "dev");
  const pip = el("div", "pip");
  wrap.append(left, wireA, hub, wireB, right, pip);
  return { wrap, left, right, wireA, wireB, hub, pip };
}

// Pixel positions are read once, after layout, so the travelling dot lands on the wire
// whatever the translated hub label does to the flex widths.
function railGeometry(parts) {
  const base = parts.wrap.getBoundingClientRect();
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left - base.left, right: r.right - base.left };
  };
  return { left: box(parts.left), hub: box(parts.hub), right: box(parts.right) };
}

const SHOTS = {
  1(scene, s) {
    const glow = el("div", "glow");
    const col = el("div", "col");
    const lines = s.lines.map((text) => el("div", "big", text));
    const kicker = el("div", "kicker mono", s.kicker);
    col.append(...lines, kicker);
    scene.append(glow, col);

    return (t) => {
      lines.forEach((node, i) => rise(node, at(t, 200 + i * 520, 760), 24));
      rise(kicker, at(t, 2700, 900), 16);
      glow.style.opacity = String(0.3 + 0.4 * easeInOut(at(t, 0, 4200)));
    };
  },

  2(scene, s) {
    const col = el("div", "col");
    const parts = rail(s.box);
    const under = el("div", "under");
    const caption = el("div", "caption", s.caption);
    under.append(caption);
    col.append(parts.wrap, under);
    scene.append(col);
    const geo = railGeometry(parts);

    return (t) => {
      rise(parts.left, at(t, 0, 700), 18);
      rise(parts.right, at(t, 200, 700), 18);
      rise(parts.hub, at(t, 500, 700), 18);
      parts.wireA.style.transform = `scaleX(${easeOut(at(t, 900, 600))})`;
      parts.wireB.style.transform = `scaleX(${easeOut(at(t, 1300, 600))})`;

      // One pass through the middle: out of the left browser, a pause inside the box,
      // on to the right one. The pause is the point of the shot.
      const legA = at(t, 2000, 1200);
      const hold = at(t, 3200, 300);
      const legB = at(t, 3500, 1200);
      let x = null;
      if (legA > 0 && hold === 0) x = lerp(geo.left.right, geo.hub.left, easeInOut(legA));
      else if (hold > 0 && legB === 0) x = geo.hub.left + (geo.hub.right - geo.hub.left) * hold;
      else if (legB > 0) x = lerp(geo.hub.right, geo.right.left, easeInOut(legB));
      if (x === null || t < 2000 || t > 4700) {
        parts.pip.style.opacity = "0";
      } else {
        parts.pip.style.opacity = "1";
        parts.pip.style.left = `${x}px`;
      }

      const lit = Math.sin(Math.PI * at(t, 2900, 1100));
      parts.hub.style.borderColor = `rgba(255, 255, 255, ${0.1 + 0.35 * lit})`;
      parts.hub.style.background = `rgba(255, 255, 255, ${0.04 + 0.06 * lit})`;

      rise(caption, at(t, 3800, 800), 14);
    };
  },

  3(scene, s) {
    const glow = el("div", "glow");
    const col = el("div", "col");
    const parts = rail("");
    const own = el("div", "hub own", s.own);
    parts.wrap.append(own);
    const under = el("div", "under");
    const headline = el("div", "headline", s.headline);
    col.append(parts.wrap, under);
    scene.append(glow, col);
    const geo = railGeometry(parts);

    let mark = null;
    const frame = (t) => {
      // Everything carries over from shot 2 already drawn, so only the middle changes.
      parts.left.style.opacity = "1";
      parts.right.style.opacity = "1";
      parts.left.style.transform = "none";
      parts.right.style.transform = "none";
      parts.wireA.style.transform = "scaleX(1)";
      parts.wireB.style.transform = "scaleX(1)";

      const gone = easeInOut(at(t, 0, 800));
      parts.hub.style.opacity = String(1 - gone);
      parts.hub.style.transform = `scale(${1 - 0.12 * gone})`;

      const arrived = at(t, 600, 800);
      own.style.opacity = String(easeOut(arrived));
      own.style.transform = `scale(${lerp(0.9, 1, easeOut(arrived))})`;

      const live = at(t, 900, 700);
      parts.wireA.style.background = wireColour(live);
      parts.wireB.style.background = wireColour(live);

      const run = at(t, 1500, 1500);
      if (run > 0 && run < 1) {
        parts.pip.style.opacity = "1";
        parts.pip.style.left = `${lerp(geo.left.right, geo.right.left, easeInOut(run))}px`;
      } else {
        parts.pip.style.opacity = "0";
      }

      if (mark) rise(mark, at(t, 2600, 900), 18);
      rise(headline, at(t, 3400, 900), 18);
      glow.style.opacity = String(0.5 * easeInOut(at(t, 2000, 2500)));
    };

    return wordmarkNode().then((node) => {
      mark = node;
      under.append(mark, headline);
      return frame;
    });
  },

  7(scene, s) {
    const col = el("div", "col");
    const list = el("div", "claims");
    const claims = s.claims.map((text) => {
      const row = el("div", "claim");
      row.append(el("div", "dash"), el("div", null, text));
      list.append(row);
      return row;
    });
    const footnote = el("div", "footnote mono", s.footnote);
    col.append(list, footnote);
    scene.append(col);

    return (t) => {
      claims.forEach((row, i) => {
        const p = at(t, 300 + i * 1200, 700);
        const e = easeOut(p);
        row.style.opacity = String(e);
        row.style.transform = `translateX(${(1 - e) * -26}px)`;
      });
      rise(footnote, at(t, 5200, 900), 14);
    };
  },

  8(scene, s) {
    const glow = el("div", "glow");
    const col = el("div", "col");
    const stores = el("div", "stores", s.stores);
    const url = el("div", "url mono", s.url);
    const sweep = el("div", "sweep");
    scene.append(glow, col);

    let mark = null;
    const frame = (t) => {
      if (mark) rise(mark, at(t, 200, 900), 16);
      sweep.style.width = `${360 * easeOut(at(t, 900, 900))}px`;
      rise(stores, at(t, 1400, 800), 14);
      rise(url, at(t, 1900, 800), 14);
      glow.style.opacity = String(0.55 * easeInOut(at(t, 0, 2600)));
    };

    return wordmarkNode().then((node) => {
      mark = node;
      col.append(mark, sweep, stores, url);
      return frame;
    });
  },
};

let current = null;

window.__shots = DURATION;

window.__load = async function load(lang, shot) {
  const text = await (await fetch(`/text/${lang}.json`)).json();
  const scene = document.getElementById("scene");
  scene.innerHTML = "";
  document.documentElement.lang = text.lang;
  const build = SHOTS[shot];
  if (!build) throw new Error(`no such kinetic shot: ${shot}`);
  const section = text.shots[String(shot)];
  if (!section) throw new Error(`${lang}.json has no text for shot ${shot}`);
  current = await build(scene, section);
  await document.fonts.ready;
  window.__duration = DURATION[shot];
  current(0);
  return window.__duration;
};

window.__seek = function seek(ms) {
  if (!current) throw new Error("__load first");
  current(ms);
};

// Designing by hand: /kinetic/?lang=en&shot=3&t=1240
const params = new URLSearchParams(location.search);
if (params.has("shot")) {
  const lang = params.get("lang") ?? "en";
  const shot = Number(params.get("shot"));
  window.__load(lang, shot).then(() => window.__seek(Number(params.get("t") ?? 0)));
}
