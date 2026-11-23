// Source rectangles in portrait-parts.webp followed by their coordinates
// on the original portrait. Order matches the editable layer file.
const atlas = {
  'shadow': [1, 1, 274, 24, 130, 588],
  'back-hair-left': [277, 1, 253, 293, 9, 287],
  'back-hair-right': [532, 1, 292, 318, 246, 264],
  'tail': [1, 321, 241, 176, 298, 400],
  'leg-left': [244, 321, 59, 93, 172, 522],
  'leg-right': [305, 321, 66, 94, 275, 520],
  'hand-left': [373, 321, 50, 37, 72, 403],
  'hand-right': [425, 321, 54, 43, 373, 403],
  'sleeve-left': [481, 321, 91, 84, 93, 366],
  'sleeve-right': [574, 321, 96, 88, 317, 365],
  'bodice': [672, 321, 216, 101, 139, 309],
  'skirt': [1, 499, 339, 161, 79, 395],
  'head-base': [342, 499, 341, 319, 90, 10],
  'fin-left': [685, 499, 81, 74, 41, 196],
  'fin-right': [768, 499, 115, 73, 360, 199],
  'front-hair': [1, 820, 274, 255, 98, 74],
  'face': [277, 820, 169, 148, 164, 171],
  'bonnet': [448, 820, 279, 137, 109, 47],
  'ahoge': [729, 820, 94, 60, 178, 12],
  'lock-left': [825, 820, 82, 103, 110, 277],
  'lock-right': [909, 820, 48, 103, 307, 276],
  'bow-left': [959, 820, 21, 33, 101, 177],
  'bow-right': [1, 1077, 61, 46, 358, 171],
  'brow-left': [64, 1077, 27, 14, 178, 198],
  'brow-right': [93, 1077, 30, 8, 270, 187],
  'eye-white-left': [125, 1077, 56, 52, 167, 232],
  'eye-white-right': [183, 1077, 67, 54, 263, 219],
  'iris-left': [252, 1077, 34, 40, 186, 242],
  'iris-right': [288, 1077, 38, 40, 274, 230],
  'lash-left': [328, 1077, 56, 45, 164, 232],
  'lash-right': [386, 1077, 66, 41, 267, 218],
  'mouth': [454, 1077, 36, 27, 233, 282],
};

const width = 539;
const height = 628;
const radians = Math.PI / 180;

function move(context, x, y, angle, sx = 1, sy = 1) {
  context.translate(x, y);
  context.rotate(angle * radians);
  context.scale(sx, sy);
  context.translate(-x, -y);
}

function drawPart(context, texture, name) {
  const [x, y, w, h, left, top] = atlas[name];
  context.drawImage(texture, x, y, w, h, left, top, w, h);
}

function swing(context, texture, name, x, y, angle) {
  context.save();
  move(context, x, y, angle);
  drawPart(context, texture, name);
  context.restore();
}

function drawEye(context, texture, side, y, openness, lookX, lookY) {
  context.save();
  context.translate(0, y);
  context.scale(1, openness);
  context.translate(0, -y);
  drawPart(context, texture, 'eye-white-' + side);
  context.save();
  context.translate(lookX * 1.6, lookY * 1.4);
  drawPart(context, texture, 'iris-' + side);
  context.restore();
  drawPart(context, texture, 'lash-' + side);
  context.restore();
}

export function drawPortrait(context, texture, time, lookX, lookY, openness, greeting) {
  const cycle = time * 1.75;
  const breath = Math.sin(cycle);
  context.clearRect(0, 0, width, height);
  context.save();
  move(context, width / 2, height / 2, 0, 0.964, 0.964);
  drawPart(context, texture, 'shadow');
  swing(context, texture, 'back-hair-left', 156, 255, Math.sin(cycle - 0.5) * 0.55);
  swing(context, texture, 'back-hair-right', 347, 257, Math.sin(cycle - 0.8) * 0.65);
  swing(context, texture, 'tail', 358, 532, Math.sin(cycle - 0.9) * 1.9 + 2.2 * greeting);
  drawPart(context, texture, 'leg-left');
  drawPart(context, texture, 'leg-right');

  context.save();
  move(context, 252, 518, 0, 1 + 0.003 * breath, 1 + 0.006 * breath);
  // Hands use the same shoulder motion as their sleeves. The cuffs cover
  // the wrist joint while both sets of parts follow a wave.
  swing(context, texture, 'hand-left', 166, 391, -0.6 * breath);
  swing(context, texture, 'hand-right', 342, 391, 0.7 * breath - 6 * greeting);
  swing(context, texture, 'sleeve-left', 166, 391, -0.6 * breath);
  swing(context, texture, 'sleeve-right', 342, 391, 0.7 * breath - 6 * greeting);
  drawPart(context, texture, 'bodice');
  context.save();
  move(context, 248, 399, breath * 0.28, 1 + breath * 0.006);
  drawPart(context, texture, 'skirt');
  context.restore();

  context.translate(lookX * 2.8, lookY * 1.6);
  move(context, 248, 309, lookX * 1.4 + Math.sin(cycle * 0.65) * 0.65 + greeting);
  drawPart(context, texture, 'head-base');
  swing(context, texture, 'fin-left', 108, 214, -breath * 0.65 - greeting * 0.9);
  swing(context, texture, 'fin-right', 375, 217, breath * 0.75 + greeting * 0.9);
  drawPart(context, texture, 'front-hair');
  drawPart(context, texture, 'face');
  drawPart(context, texture, 'bonnet');
  swing(context, texture, 'ahoge', 258, 68, -breath * 1.65 + 3 * greeting);
  swing(context, texture, 'lock-left', 158, 310, Math.sin(cycle - 0.4) * 0.95);
  swing(context, texture, 'lock-right', 326, 307, Math.sin(cycle - 0.7) * 1.05);
  drawPart(context, texture, 'bow-left');
  drawPart(context, texture, 'bow-right');
  drawPart(context, texture, 'brow-left');
  drawPart(context, texture, 'brow-right');
  drawEye(context, texture, 'left', 262, openness, lookX, lookY);
  drawEye(context, texture, 'right', 254, openness, lookX, lookY);
  context.save();
  move(context, 250, 293, 0, 1 + 0.023 * breath, 1 + 0.055 * breath + 0.19 * greeting);
  drawPart(context, texture, 'mouth');
  context.restore();
  context.restore();
  context.restore();
}

function runPortrait() {
  const canvas = document.querySelector('.companion-portrait canvas');
  const still = canvas?.previousElementSibling;
  if (!still) return;
  const button = document.getElementById('portrait-playback');
  const status = document.getElementById('portrait-playback-status');
  const context = canvas.getContext('2d');
  if (!context) {
    status.textContent = '当前浏览器无法播放立绘动画。';
    return;
  }

  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const texture = new Image();
  const directPlay = new URLSearchParams(location.search).get('portrait') === 'play';
  let choice = directPlay ? true : null;
  let waveOnStart = directPlay;
  let loadState = 'idle', loadError = '';
  let intersects = typeof IntersectionObserver === 'undefined';
  let request = 0;
  let lookX = 0, lookY = 0, targetX = 0, targetY = 0;
  let previous = 0, clock = 0;
  let blinkAt = 2.4, greetUntil = 0;
  const clamp = value => Math.max(-1, Math.min(1, value));

  function tick(timestamp) {
    request = 0;
    const elapsed = previous ? Math.min(0.05, (timestamp - previous) / 1000) : 0;
    previous = timestamp;
    clock += elapsed;
    const easing = 1 - Math.exp(-elapsed * 9);
    lookX += (targetX - lookX) * easing;
    lookY += (targetY - lookY) * easing;
    const blink = clock - blinkAt;
    const openness = blink >= 0 && blink < 0.19 ? Math.max(0.04, 1 - Math.sin(Math.PI * blink / 0.19)) : 1;
    if (blink >= 0.19) blinkAt = clock + 2.3 + Math.random() * 2.8;
    const greeting = greetUntil > clock ? Math.sin(Math.PI * (greetUntil - clock) / 0.75) : 0;
    drawPortrait(context, texture, clock, lookX, lookY, openness, greeting);
    request = requestAnimationFrame(tick);
  }

  function greet() {
    if (greetUntil <= clock) {
      greetUntil = clock + 0.75;
      blinkAt = clock + 0.06;
    }
  }

  async function loadTexture() {
    let objectUrl;
    try {
      const response = await fetch('/web.js?asset=portrait-parts');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      objectUrl = URL.createObjectURL(await response.blob());
      texture.src = objectUrl;
      await texture.decode();
      if (texture.naturalWidth !== 1024 || texture.naturalHeight !== 1132) {
        throw new Error('尺寸与动画模型不匹配');
      }
      loadState = 'ready';
    } catch (error) {
      loadState = 'failed';
      loadError = error.message;
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
    update();
  }

  function update() {
    const play = choice ?? !motion.matches;
    const active = play && intersects && !document.hidden;
    if (active && loadState === 'idle') {
      loadState = 'loading';
      void loadTexture();
    }
    button.textContent = loadState === 'failed' ? '重试动画' : play ? '暂停动画' : '播放立绘';
    if (loadState === 'failed') status.textContent = '立绘素材载入失败（' + loadError + '）。';
    else if (loadState === 'loading' && play) status.textContent = '正在载入立绘素材…';
    else if (choice === null && motion.matches) status.textContent = '系统已开启「减少动态效果」。';
    else status.textContent = '';

    if (active && loadState === 'ready') {
      if (canvas.hidden) {
        if (waveOnStart) {
          greet();
          waveOnStart = false;
        }
        drawPortrait(context, texture, clock, lookX, lookY, 1, 0);
        canvas.hidden = false;
        still.hidden = true;
      }
      if (!request) request = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(request);
      request = 0;
      previous = 0;
      if (!play) {
        still.hidden = false;
        canvas.hidden = true;
      }
    }
  }

  button.disabled = false;
  button.addEventListener('click', () => {
    if (loadState === 'failed') {
      loadState = 'idle';
      choice = true;
    } else {
      choice = !(choice ?? !motion.matches);
    }
    waveOnStart = choice;
    update();
  });
  if (!intersects) {
    new IntersectionObserver(([entry]) => {
      intersects = entry.isIntersecting;
      update();
    }).observe(canvas.parentElement);
  }
  update();
  document.addEventListener('visibilitychange', update);
  motion.addEventListener('change', update);
  canvas.addEventListener('pointermove', event => {
    const box = canvas.getBoundingClientRect();
    targetX = clamp((event.clientX - box.left) / box.width * 2 - 1);
    targetY = clamp((event.clientY - box.top) / box.height * 2 - 1);
  });
  canvas.addEventListener('pointerleave', () => { targetX = 0; targetY = 0; });
  canvas.addEventListener('pointerdown', greet);
}

if (typeof document !== 'undefined') runPortrait();
