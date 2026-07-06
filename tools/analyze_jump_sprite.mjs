// Cat01_Jumping.png 알파 분석 — 5행 × 5열 = 25 프레임의 실제 bbox 추출.
// running/sliding과 동일 방식으로 프레임별 {x, w, bot} 실측값을 얻는다.
// 실행: node tools/analyze_jump_sprite.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const path = new URL("../IMG/Cat01_Jumping.png", import.meta.url);
const buf = fs.readFileSync(path);

// PNG 서명 스킵.
let p = 8;
const chunks = {};
const idatBufs = [];
let width = 0, height = 0, colorType = 0, bitDepth = 0;
while (p < buf.length) {
  const len = buf.readUInt32BE(p); p += 4;
  const type = buf.toString("ascii", p, p + 4); p += 4;
  const data = buf.slice(p, p + len); p += len + 4; // +4 = CRC skip
  if (type === "IHDR") {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data.readUInt8(8);
    colorType = data.readUInt8(9);
  } else if (type === "IDAT") {
    idatBufs.push(data);
  } else if (type === "IEND") break;
}
if (colorType !== 6 || bitDepth !== 8) {
  throw new Error(`RGBA 8bit이 아님: colorType=${colorType} bitDepth=${bitDepth}`);
}
const raw = zlib.inflateSync(Buffer.concat(idatBufs));

// PNG 스캔라인 filter 처리 → 픽셀 배열(RGBA).
const bpp = 4; // bytes per pixel
const stride = width * bpp;
const pixels = Buffer.alloc(height * stride);
let src = 0;
for (let y = 0; y < height; y++) {
  const filter = raw[src++];
  const rowStart = y * stride;
  for (let x = 0; x < stride; x++) {
    const cur = raw[src++];
    const a = x >= bpp ? pixels[rowStart + x - bpp] : 0;
    const b = y > 0 ? pixels[rowStart - stride + x] : 0;
    const c = x >= bpp && y > 0 ? pixels[rowStart - stride + x - bpp] : 0;
    let val;
    switch (filter) {
      case 0: val = cur; break;
      case 1: val = cur + a; break;
      case 2: val = cur + b; break;
      case 3: val = cur + ((a + b) >> 1); break;
      case 4: {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = cur + pr; break;
      }
      default: throw new Error(`unknown filter ${filter}`);
    }
    pixels[rowStart + x] = val & 0xff;
  }
}

function alphaAt(x, y) { return pixels[y * stride + x * bpp + 3]; }

// 5행 × 5열 셀 크기.
const cols = 5, rows = 5;
const cellW = width / cols;   // 1433 / 5 = 286.6
const cellH = height / rows;  // 2400 / 5 = 480

const ALPHA_THRESHOLD = 32;
const frames = [];
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const cx0 = Math.round(c * cellW);
    const cx1 = Math.round((c + 1) * cellW);
    const cy0 = Math.round(r * cellH);
    const cy1 = Math.round((r + 1) * cellH);
    let minX = cx1, maxX = cx0 - 1, minY = cy1, maxY = cy0 - 1;
    for (let y = cy0; y < cy1; y++) {
      for (let x = cx0; x < cx1; x++) {
        if (alphaAt(x, y) >= ALPHA_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    frames.push({ row: r, col: c, x: minX, w: maxX - minX + 1, bot: maxY, top: minY, h: maxY - minY + 1 });
  }
}

console.log(`이미지: ${width}x${height}, cell ${cellW}x${cellH}`);
console.log("행별 프레임 (x, w, bot, top, h):");
for (const f of frames) {
  console.log(`  [r${f.row} c${f.col}] x=${f.x} w=${f.w} bot=${f.bot} top=${f.top} h=${f.h}`);
}

// running/sliding 코드 형식으로 직접 출력.
console.log("\n// 1행 (도약 준비 5프레임):");
for (let c = 0; c < 5; c++) {
  const f = frames[c];
  console.log(`  { x: ${f.x}, w: ${f.w}, bot: ${f.bot} },`);
}
console.log("\n// 2행 (공중 유지 4프레임 = 인덱스 0~3):");
for (let c = 0; c < 4; c++) {
  const f = frames[5 + c];
  console.log(`  { x: ${f.x}, w: ${f.w}, bot: ${f.bot} },`);
}

// 최대 h — src crop 높이 결정.
let maxH1 = 0, maxH2 = 0;
for (let c = 0; c < 5; c++) if (frames[c].h > maxH1) maxH1 = frames[c].h;
for (let c = 0; c < 4; c++) if (frames[5 + c].h > maxH2) maxH2 = frames[5 + c].h;
console.log(`\n1행 최대 h=${maxH1}, 2행(0~3) 최대 h=${maxH2}`);
