// 장애물 3개 스프라이트 알파 bbox 실측 — 여백 파악해서 crop 파라미터 산출.
// 실행: node tools/analyze_obstacle_sprites.mjs
import fs from "node:fs";
import zlib from "node:zlib";

function analyzePng(name) {
  const path = new URL(`../IMG/${name}.png`, import.meta.url);
  const buf = fs.readFileSync(path);
  let p = 8;
  const idatBufs = [];
  let width = 0, height = 0;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); p += 4;
    const type = buf.toString("ascii", p, p + 4); p += 4;
    const data = buf.slice(p, p + len); p += len + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idatBufs.push(data);
    } else if (type === "IEND") break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatBufs));
  const bpp = 4;
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
  const ALPHA_THRESHOLD = 32;
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = pixels[y * stride + x * bpp + 3];
      if (a >= ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  console.log(
    `${name} (${width}×${height}) — bbox x=${minX} y=${minY} w=${bw} h=${bh} (여백 좌${minX} 우${width - maxX - 1} 상${minY} 하${height - maxY - 1})`,
  );
}

analyzePng("LowObstacle_Puddle");
analyzePng("HighObstacle_Pot");
analyzePng("AirObstacle_Chandelier");
