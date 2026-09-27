// 程序化生成的贴图：骰面、碗的纹饰、红色桌布
import * as THREE from 'three';

const PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.26, 0.26], [0.5, 0.5], [0.74, 0.74]],
  4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.3, 0.24], [0.7, 0.24], [0.3, 0.5], [0.7, 0.5], [0.3, 0.76], [0.7, 0.76]],
};

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(c, { repeat = false, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 骰面贴图：1 点和 4 点为红色（中式骰子） */
export function dieFaceTexture(value) {
  const S = 256;
  const [c, g] = canvas(S);
  g.fillStyle = '#fbf7ee';
  g.fillRect(0, 0, S, S);
  const red = value === 1 || value === 4;
  const r = value === 1 ? S * 0.16 : S * 0.085;
  for (const [x, y] of PIPS[value]) {
    const px = x * S, py = y * S;
    const grad = g.createRadialGradient(px - r * 0.3, py - r * 0.3, r * 0.1, px, py, r);
    if (red) {
      grad.addColorStop(0, '#e8413a');
      grad.addColorStop(1, '#a3100f');
    } else {
      grad.addColorStop(0, '#3a3a3a');
      grad.addColorStop(1, '#070707');
    }
    g.fillStyle = grad;
    g.beginPath();
    g.arc(px, py, r, 0, Math.PI * 2);
    g.fill();
    // 凹坑下沿的高光，增加立体感
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = r * 0.18;
    g.beginPath();
    g.arc(px, py, r * 0.92, Math.PI * 0.15, Math.PI * 0.85);
    g.stroke();
  }
  return toTexture(c);
}

function fret(g, x0, y0, u, color) {
  // 回纹单元：方形螺旋
  g.strokeStyle = color;
  g.lineWidth = u * 0.16;
  g.lineCap = 'square';
  g.beginPath();
  g.moveTo(x0, y0 + u);
  g.lineTo(x0, y0);
  g.lineTo(x0 + u, y0);
  g.lineTo(x0 + u, y0 + u * 0.8);
  g.lineTo(x0 + u * 0.3, y0 + u * 0.8);
  g.lineTo(x0 + u * 0.3, y0 + u * 0.3);
  g.lineTo(x0 + u * 0.65, y0 + u * 0.3);
  g.lineTo(x0 + u * 0.65, y0 + u * 0.55);
  g.stroke();
  g.beginPath();
  g.moveTo(x0 + u, y0 + u);
  g.lineTo(x0 + u * 1.25, y0 + u);
  g.stroke();
}

function medallion(g, x, y, R, ch) {
  g.fillStyle = '#b81d1d';
  g.beginPath();
  g.arc(x, y, R, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#e7b75a';
  g.lineWidth = R * 0.08;
  g.beginPath();
  g.arc(x, y, R * 0.84, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#f6d98a';
  g.font = `bold ${R * 1.05}px "STKaiti","KaiTi","Kaiti SC","楷体",serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(ch, x, y + R * 0.05);
}

/** 碗外壁：v=1 为碗口，v=0 为底 */
export function bowlOuterTexture() {
  const W = 2048, H = 512;
  const [c, g] = canvas(W, H);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#fffdf8');
  grad.addColorStop(1, '#f1eadc');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // 口沿金线
  g.fillStyle = '#d9a441';
  g.fillRect(0, 0, W, 10);
  // 红色回纹带
  const bandY = 22, bandH = 70;
  g.fillStyle = '#b81d1d';
  g.fillRect(0, bandY, W, bandH);
  g.fillStyle = '#e7b75a';
  g.fillRect(0, bandY + 4, W, 3);
  g.fillRect(0, bandY + bandH - 7, W, 3);
  const u = 40;
  for (let x = 0; x < W; x += u * 1.6) fret(g, x + 8, bandY + 15, u, '#f2cf7c');
  // 团花
  const chars = ['福', '禄', '寿', '喜'];
  const n = 8;
  for (let i = 0; i < n; i++) medallion(g, (i + 0.5) * (W / n), 220, 62, chars[i % 4]);
  // 缠枝细线
  g.strokeStyle = 'rgba(184,29,29,0.5)';
  g.lineWidth = 3;
  g.beginPath();
  for (let x = 0; x <= W; x += 4) g.lineTo(x, 330 + Math.sin((x / W) * Math.PI * 32) * 10);
  g.stroke();
  // 足部红线
  g.fillStyle = '#b81d1d';
  g.fillRect(0, H - 90, W, 8);
  g.fillStyle = '#d9a441';
  g.fillRect(0, H - 70, W, 4);
  return toTexture(c, { repeat: true });
}

/** 碗内壁：v=0 为底，v=1 为碗口 */
export function bowlInnerTexture() {
  const W = 1024, H = 512;
  const [c, g] = canvas(W, H);
  const grad = g.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, '#fbf8f1');
  grad.addColorStop(1, '#fffefb');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#d9a441';
  g.fillRect(0, 0, W, 6);
  g.fillStyle = '#b81d1d';
  g.fillRect(0, 16, W, 10);
  g.fillStyle = 'rgba(184,29,29,0.8)';
  g.fillRect(0, 34, W, 3);
  return toTexture(c, { repeat: true });
}

/** 碗底中心纹饰 */
export function bowlBottomTexture() {
  const S = 512;
  const [c, g] = canvas(S);
  g.clearRect(0, 0, S, S);
  const R = S / 2;
  g.strokeStyle = '#b81d1d';
  g.lineWidth = 10;
  g.beginPath();
  g.arc(R, R, R * 0.92, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 4;
  g.beginPath();
  g.arc(R, R, R * 0.82, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(184,29,29,0.9)';
  g.font = `bold ${R * 0.95}px "STKaiti","KaiTi","Kaiti SC","楷体",serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('福', R, R * 1.04);
  return toTexture(c);
}

/** 红色桌布，中心一圈金色纹样 */
export function tableTexture() {
  const S = 1024;
  const [c, g] = canvas(S);
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.7);
  grad.addColorStop(0, '#b3201c');
  grad.addColorStop(0.55, '#8c1512');
  grad.addColorStop(1, '#3d0707');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // 布纹噪点
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 16 + (((i / 4) % S) % 4 === 0 ? -6 : 0);
    img.data[i] += n;
    img.data[i + 1] += n * 0.4;
    img.data[i + 2] += n * 0.4;
  }
  g.putImageData(img, 0, 0);
  // 金色圆环与云纹点缀
  g.strokeStyle = 'rgba(231,183,90,0.55)';
  g.lineWidth = 5;
  for (const r of [0.3, 0.315]) {
    g.beginPath();
    g.arc(S / 2, S / 2, S * r, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = 'rgba(231,183,90,0.45)';
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const x = S / 2 + Math.cos(a) * S * 0.3075;
    const y = S / 2 + Math.sin(a) * S * 0.3075;
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.fill();
  }
  return toTexture(c);
}
