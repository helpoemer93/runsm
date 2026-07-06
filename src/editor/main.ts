import { Stage, TRACK_SAFE_PREFIX } from "../sim/stage";
import stage1Data from "../data/stages/stage1.json";

type Tool =
  | "low-obstacle"
  | "high-obstacle"
  | "ceiling-obstacle"
  | "item-1"
  | "item-5"
  | "item-20"
  | "cluster"
  | "effect-heal"
  | "effect-magnet"
  | "effect-dash"
  | "effect-giant"
  | "erase";

const SNAP = 10;
const GROUND_Y = 240;
const LOW_OBSTACLE_HEIGHT = 30;
const HIGH_OBSTACLE_HEIGHT = 150;
const CEILING_YBOTTOM = 30;
const CEILING_HEIGHT = 90;
const MIN_OBSTACLE_WIDTH = 20;

const CLUSTER_GRID = 3;
const CLUSTER_SPACING = 20;

const canvas = document.getElementById("editor-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const trackIdInput = document.getElementById("track-id") as HTMLInputElement;
const trackLengthInput = document.getElementById(
  "track-length",
) as HTMLInputElement;
const jsonOutput = document.getElementById("json-output") as HTMLTextAreaElement;
const scrollSlider = document.getElementById("scroll") as HTMLInputElement;
const scrollLabel = document.getElementById("scroll-label")!;

const track: Stage = {
  id: "new-track",
  length: 5000,
  obstacles: [],
  items: [],
};

let currentTool: Tool = "low-obstacle";
let scrollX = 0;
let drag: {
  startX: number;
  tool: "low-obstacle" | "high-obstacle" | "ceiling-obstacle";
} | null = null;
let mouseTrackX = 0;
let mouseCanvasY = 0;

function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

function canvasToTrackX(canvasX: number): number {
  return snap(canvasX + scrollX);
}

function canvasToSimY(canvasY: number): number {
  // 캔버스 y는 위에서 아래로. sim y는 지면(GROUND_Y)에서 위로.
  return Math.max(0, snap(GROUND_Y - canvasY));
}

function valueForTool(tool: Tool): number {
  if (tool === "item-5") return 5;
  if (tool === "item-20") return 20;
  return 1;
}

type ItemLike = { value?: number; effect?: "magnet" | "dash" | "giant" | "heal" };

function itemStyle(item: ItemLike) {
  if (item.effect === "heal") return { fill: "#f7a", stroke: "#a35", radius: 12, glyph: "♥" };
  if (item.effect === "magnet") return { fill: "#a4d", stroke: "#629", radius: 12, glyph: "U" };
  if (item.effect === "dash") return { fill: "#f73", stroke: "#a30", radius: 12, glyph: "⚡" };
  if (item.effect === "giant") return { fill: "#ff5", stroke: "#aa0", radius: 14, glyph: "★" };
  const value = item.value ?? 1;
  if (value >= 20) return { fill: "#c6f", stroke: "#73a", radius: 13, glyph: undefined as string | undefined };
  if (value >= 5) return { fill: "#f93", stroke: "#a40", radius: 10, glyph: undefined };
  return { fill: "#fc0", stroke: "#a80", radius: 8, glyph: undefined };
}

function updateScrollBounds() {
  const maxScroll = Math.max(0, track.length - canvas.width);
  scrollSlider.max = String(maxScroll);
  if (scrollX > maxScroll) scrollX = maxScroll;
  scrollSlider.value = String(scrollX);
  scrollLabel.textContent = String(scrollX);
}

function updateJson() {
  jsonOutput.value = JSON.stringify(track, null, 2);
}

function render() {
  ctx.fillStyle = "#87ceeb";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#5a3";
  ctx.fillRect(0, GROUND_Y, canvas.width, canvas.height - GROUND_Y);

  // 격자
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  const firstGrid = Math.ceil(scrollX / SNAP) * SNAP;
  for (let x = firstGrid; x < scrollX + canvas.width; x += SNAP) {
    const sx = x - scrollX;
    ctx.beginPath();
    ctx.moveTo(sx + 0.5, 0);
    ctx.lineTo(sx + 0.5, GROUND_Y);
    ctx.stroke();
  }

  // 안전 구간
  const safeLeft = Math.max(0, 0 - scrollX);
  const safeRight = Math.min(canvas.width, TRACK_SAFE_PREFIX - scrollX);
  if (safeRight > safeLeft) {
    ctx.fillStyle = "rgba(255, 80, 80, 0.18)";
    ctx.fillRect(safeLeft, 0, safeRight - safeLeft, GROUND_Y);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "11px monospace";
    ctx.fillText("안전구간 (장애물 금지)", safeLeft + 4, 14);
  }

  // 장애물
  for (const o of track.obstacles) {
    const sx = o.x - scrollX;
    if (sx + o.width < 0 || sx > canvas.width) continue;
    const yBottom = o.yBottom ?? 0;
    const yTop = yBottom + o.height;
    ctx.fillStyle = yBottom > 0 ? "#634" : "#444";
    ctx.fillRect(sx, GROUND_Y - yTop, o.width, o.height);
    ctx.fillStyle = "#fff";
    ctx.font = "10px monospace";
    const label = yBottom > 0 ? `천장 h${o.height}` : `h${o.height}`;
    ctx.fillText(label, sx + 2, GROUND_Y - yTop + 11);
  }

  // 아이템
  ctx.lineWidth = 2;
  for (const item of track.items) {
    const sx = item.x - scrollX;
    if (sx < -20 || sx > canvas.width + 20) continue;
    const sy = GROUND_Y - item.y - 10;
    const style = itemStyle(item);
    ctx.fillStyle = style.fill;
    ctx.strokeStyle = style.stroke;
    ctx.beginPath();
    ctx.arc(sx, sy, style.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (style.glyph) {
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${style.radius}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(style.glyph, sx, sy + 1);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
  }

  // 드래그 중인 장애물 미리보기
  if (drag) {
    const w = Math.max(MIN_OBSTACLE_WIDTH, mouseTrackX - drag.startX);
    let h: number, yBottom: number;
    if (drag.tool === "ceiling-obstacle") {
      yBottom = CEILING_YBOTTOM;
      h = CEILING_HEIGHT;
    } else if (drag.tool === "high-obstacle") {
      yBottom = 0;
      h = HIGH_OBSTACLE_HEIGHT;
    } else {
      yBottom = 0;
      h = LOW_OBSTACLE_HEIGHT;
    }
    const yTop = yBottom + h;
    const sx = drag.startX - scrollX;
    ctx.fillStyle = "rgba(80, 80, 80, 0.6)";
    ctx.fillRect(sx, GROUND_Y - yTop, w, h);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, GROUND_Y - yTop + 0.5, w - 1, h - 1);
  }

  // 트랙 끝선
  const endSx = track.length - scrollX;
  if (endSx >= 0 && endSx <= canvas.width) {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(endSx, 0, 2, GROUND_Y);
    ctx.fillStyle = "#fff";
    ctx.font = "11px monospace";
    ctx.fillText("끝", endSx + 4, 14);
  }
}

function eraseAt(tx: number, ty: number) {
  for (let i = track.obstacles.length - 1; i >= 0; i--) {
    const o = track.obstacles[i]!;
    const yBottom = o.yBottom ?? 0;
    const yTop = yBottom + o.height;
    if (tx >= o.x && tx <= o.x + o.width && ty >= yBottom && ty <= yTop) {
      track.obstacles.splice(i, 1);
      updateJson();
      render();
      return;
    }
  }
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < track.items.length; i++) {
    const item = track.items[i]!;
    const dx = item.x - tx;
    const dy = item.y - ty;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 20 && d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) {
    track.items.splice(bestIdx, 1);
    updateJson();
    render();
  }
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const tx = canvasToTrackX(cx);
  const ty = canvasToSimY(cy);

  if (e.button === 2 || currentTool === "erase") {
    eraseAt(tx, ty);
    return;
  }

  if (
    currentTool === "low-obstacle" ||
    currentTool === "high-obstacle" ||
    currentTool === "ceiling-obstacle"
  ) {
    if (tx < TRACK_SAFE_PREFIX) return;
    drag = { startX: tx, tool: currentTool };
    mouseTrackX = tx;
    render();
    return;
  }

  if (
    currentTool === "item-1" ||
    currentTool === "item-5" ||
    currentTool === "item-20"
  ) {
    if (tx < 0 || tx > track.length) return;
    const value = valueForTool(currentTool);
    if (value === 1) track.items.push({ x: tx, y: ty });
    else track.items.push({ x: tx, y: ty, value });
    updateJson();
    render();
    return;
  }

  if (
    currentTool === "effect-heal" ||
    currentTool === "effect-magnet" ||
    currentTool === "effect-dash" ||
    currentTool === "effect-giant"
  ) {
    if (tx < 0 || tx > track.length) return;
    const effect =
      currentTool === "effect-heal"
        ? "heal"
        : currentTool === "effect-magnet"
          ? "magnet"
          : currentTool === "effect-dash"
            ? "dash"
            : "giant";
    track.items.push({ x: tx, y: ty, effect });
    updateJson();
    render();
    return;
  }

  if (currentTool === "cluster") {
    if (tx < 0 || tx > track.length) return;
    // 클릭 위치를 중앙 격자점으로 3x3 배치
    const offset = ((CLUSTER_GRID - 1) * CLUSTER_SPACING) / 2;
    for (let gx = 0; gx < CLUSTER_GRID; gx++) {
      for (let gy = 0; gy < CLUSTER_GRID; gy++) {
        const ix = snap(tx - offset + gx * CLUSTER_SPACING);
        const iy = Math.max(0, snap(ty - offset + gy * CLUSTER_SPACING));
        if (ix < 0 || ix > track.length) continue;
        track.items.push({ x: ix, y: iy });
      }
    }
    updateJson();
    render();
    return;
  }
});

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  mouseCanvasY = e.clientY - rect.top;
  mouseTrackX = canvasToTrackX(cx);
  if (drag) render();
});

canvas.addEventListener("mouseup", (e) => {
  if (!drag) return;
  const rect = canvas.getBoundingClientRect();
  const endTx = canvasToTrackX(e.clientX - rect.left);
  const width = Math.max(MIN_OBSTACLE_WIDTH, endTx - drag.startX);
  let height: number;
  let yBottom: number;
  if (drag.tool === "ceiling-obstacle") {
    yBottom = CEILING_YBOTTOM;
    height = CEILING_HEIGHT;
  } else if (drag.tool === "high-obstacle") {
    yBottom = 0;
    height = HIGH_OBSTACLE_HEIGHT;
  } else {
    yBottom = 0;
    height = LOW_OBSTACLE_HEIGHT;
  }
  if (yBottom > 0) track.obstacles.push({ x: drag.startX, width, height, yBottom });
  else track.obstacles.push({ x: drag.startX, width, height });
  drag = null;
  updateJson();
  render();
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const max = parseInt(scrollSlider.max, 10);
    scrollX = Math.max(0, Math.min(max, scrollX + e.deltaY));
    scrollSlider.value = String(scrollX);
    scrollLabel.textContent = String(scrollX);
    render();
  },
  { passive: false },
);

scrollSlider.addEventListener("input", () => {
  scrollX = parseInt(scrollSlider.value, 10) || 0;
  scrollLabel.textContent = String(scrollX);
  render();
});

(document.getElementById("scroll-left") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    scrollX = Math.max(0, scrollX - canvas.width / 2);
    scrollSlider.value = String(scrollX);
    scrollLabel.textContent = String(scrollX);
    render();
  },
);
(document.getElementById("scroll-right") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    const max = parseInt(scrollSlider.max, 10);
    scrollX = Math.min(max, scrollX + canvas.width / 2);
    scrollSlider.value = String(scrollX);
    scrollLabel.textContent = String(scrollX);
    render();
  },
);

function setActiveTool(tool: Tool) {
  currentTool = tool;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tools button")) {
    b.classList.toggle("active", b.dataset.tool === tool);
  }
}
for (const btn of document.querySelectorAll<HTMLButtonElement>(".tools button")) {
  btn.addEventListener("click", () => setActiveTool(btn.dataset.tool as Tool));
}

trackIdInput.addEventListener("input", () => {
  track.id = trackIdInput.value.trim() || "new-track";
  updateJson();
});
trackLengthInput.addEventListener("input", () => {
  const v = parseInt(trackLengthInput.value, 10);
  if (Number.isFinite(v) && v > 0) {
    track.length = v;
    updateScrollBounds();
    updateJson();
    render();
  }
});

document.getElementById("copy")!.addEventListener("click", () => {
  navigator.clipboard.writeText(jsonOutput.value).then(
    () => alert("클립보드에 복사됨"),
    () => alert("복사 실패 — 텍스트 박스에서 직접 복사 부탁드립니다"),
  );
});
document.getElementById("download")!.addEventListener("click", () => {
  const blob = new Blob([jsonOutput.value], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${track.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
document.getElementById("load-stage1")!.addEventListener("click", () => {
  const copy = JSON.parse(JSON.stringify(stage1Data)) as Stage;
  track.id = copy.id;
  track.length = copy.length;
  track.obstacles = copy.obstacles;
  track.items = copy.items;
  trackIdInput.value = track.id;
  trackLengthInput.value = String(track.length);
  updateScrollBounds();
  updateJson();
  render();
});
document.getElementById("clear")!.addEventListener("click", () => {
  if (!confirm("장애물·아이템을 모두 삭제하시겠습니까?")) return;
  track.obstacles = [];
  track.items = [];
  updateJson();
  render();
});

trackIdInput.value = track.id;
trackLengthInput.value = String(track.length);
updateScrollBounds();
setActiveTool("low-obstacle");
updateJson();
render();
