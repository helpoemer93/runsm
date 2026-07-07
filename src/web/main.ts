import { createWorld, step, TICK_DURATION, World } from "../sim/world";
import { decide } from "../sim/bot";
import { Stage } from "../sim/stage";
import { CharacterSpec, EquipmentSpec, Loadout } from "../sim/spec";
import {
  InventoryState,
  ItemInstance,
  SLOT_COUNT,
  GACHA_COST,
  BAG_EXPAND_STEP,
  bagExpandCost,
  loadInventory,
  saveInventory,
  equippedSpecs,
  equipFromBag,
  unequipToBag,
  firstEmptySlot,
  hasBagSpace,
  lookupSpec,
  allEquipmentSpecs,
  gachaDraw,
  expandBag,
  removeBagItem,
  enhanceCost,
  enhanceInstance,
  effectiveSpec,
  allCharacters,
  allPets,
  botCharacter,
  botPet,
  setBotCharacter,
  setBotPet,
} from "./inventory";

// 시작 봇 수. 미래에 누적 코인/조건 만족 시 늘림.
const BOT_COUNT = 2;

const inventory: InventoryState = loadInventory(BOT_COUNT);

// 봇 출발 시점의 인벤토리 스냅샷으로 로드아웃 생성.
function makeLoadout(botIdx: number): Loadout {
  const character = botCharacter(inventory, botIdx);
  if (!character) {
    throw new Error("사용 가능한 캐릭터가 없음 — src/data/characters/ 확인");
  }
  return {
    character,
    pet: botPet(inventory, botIdx),
    equipment: equippedSpecs(inventory, botIdx),
  };
}

const stageModules = import.meta.glob<{ default: Stage }>(
  "../data/stages/*.json",
  { eager: true },
);
const trackPool: Stage[] = Object.values(stageModules).map((m) => m.default);
if (trackPool.length === 0) {
  throw new Error("src/data/stages/ 에 트랙 JSON이 하나도 없음");
}

const canvasContainer = document.getElementById("game-canvases")!;
const totalCoinsEl = document.getElementById("total-coins")!;

// 누적 코인은 localStorage에 보관 — 새로고침에도 유지되어 뽑기 비용의 기반이 됨.
const TOTAL_COINS_KEY = "runsm.totalCoins";

function loadTotalCoins(): number {
  const raw = localStorage.getItem(TOTAL_COINS_KEY);
  if (raw === null) return 0;
  const n = Number(raw);
  // 파싱 실패·NaN·음수 등 비정상 값은 0으로 초기화(저장된 게 깨졌을 때 안전장치).
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function saveTotalCoins(value: number) {
  localStorage.setItem(TOTAL_COINS_KEY, String(value));
}

let totalCoins = loadTotalCoins();
function renderTotalCoins() {
  totalCoinsEl.textContent = String(totalCoins);
}
renderTotalCoins();

// === 에러리포트 시스템 ===
// 봇이 장애물에 충돌(데미지 30 발생)할 때마다 디버깅 컨텍스트를 한 덩어리로 누적.
// 사용자가 "에러리포트" 모달에서 한 번에 전체 복사 → 진단에 전달.
const ERROR_REPORTS_KEY = "runsm.errorReports";
const ERROR_REPORTS_MAX = 20;

interface ErrorReport {
  ts: number;
  seed: number | null;
  botIndex: number;
  runCount: number;
  tick: number;
  trackId: string;
  trackLength: number;
  obstacle: {
    idx: number;
    x: number;
    width: number;
    height: number;
    yBottom: number;
  };
  runner: {
    x: number;
    y: number;
    vy: number;
    hp: number;
    jumpsLeft: number;
    onGround: boolean;
    invincibleTicks: number;
    magnetTicks: number;
    giantTicks: number;
    itemDashTicks: number;
  };
  skills: { id: string; activeTicks: number; cooldownTicks: number }[];
  loadout: {
    character: string;
    pet: string;
    equipment: { specId: string; level: number }[];
  };
  jumpHistory: {
    tick: number;
    x: number;
    y: number;
    vy: number;
    type: "단점프" | "이단점프";
  }[];
  // 봇 주변 미수집 아이템 (r.x-200 ~ r.x+500)
  nearbyItems: {
    src: "정적" | "spawn";
    x: number;
    y: number;
    v?: number;
    effect?: string;
  }[];
  // 같은 범위 안 미파괴 장애물
  nearbyObstacles: {
    x: number;
    width: number;
    height: number;
    yBottom: number;
  }[];
}

function loadErrorReports(): ErrorReport[] {
  const raw = localStorage.getItem(ERROR_REPORTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, ERROR_REPORTS_MAX);
  } catch {
    return [];
  }
}

function saveErrorReports() {
  try {
    localStorage.setItem(ERROR_REPORTS_KEY, JSON.stringify(errorReports));
  } catch {
    // 용량 초과 등 — 무시
  }
}

let errorReports: ErrorReport[] = loadErrorReports();

const errorButton = document.getElementById("error-button") as HTMLButtonElement;
const errorCountEl = document.getElementById("error-count")!;
const errorModal = document.getElementById("error-modal")!;
const errorCloseButton = document.getElementById(
  "error-close",
) as HTMLButtonElement;
const errorCopyButton = document.getElementById(
  "error-copy",
) as HTMLButtonElement;
const errorClearButton = document.getElementById(
  "error-clear",
) as HTMLButtonElement;
const errorLogEl = document.getElementById("error-log") as HTMLTextAreaElement;
const errorStatusEl = document.getElementById("error-status")!;

function renderErrorButton() {
  errorCountEl.textContent = String(errorReports.length);
  errorButton.dataset.empty = errorReports.length === 0 ? "1" : "0";
}

function formatErrorLog(): string {
  if (errorReports.length === 0) return "(에러리포트 없음)";
  return errorReports
    .map((r, i) => `=== #${i + 1} ===\n${JSON.stringify(r, null, 2)}`)
    .join("\n\n");
}

function renderErrorLog() {
  errorLogEl.value = formatErrorLog();
}

function recordCollision(bot: Bot) {
  const w = bot.world;
  if (!w || !w.lastCollision) return;
  const obs = w.currentTrack.obstacles[w.lastCollision.obstacleIdx];
  if (!obs) return;
  const r = w.runner;
  const nearbyXMin = r.x - 200;
  const nearbyXMax = r.x + 500;
  const nearbyItems: ErrorReport["nearbyItems"] = [];
  for (let i = 0; i < w.currentTrack.items.length; i++) {
    if (w.currentItemCollected[i]) continue;
    const it = w.currentTrack.items[i]!;
    if (it.x < nearbyXMin || it.x > nearbyXMax) continue;
    nearbyItems.push({
      src: "정적",
      x: it.x,
      y: it.y,
      v: it.value,
      effect: it.effect,
    });
  }
  for (const sp of w.spawnedItems) {
    if (sp.collected) continue;
    if (sp.x < nearbyXMin || sp.x > nearbyXMax) continue;
    nearbyItems.push({
      src: "spawn",
      x: Math.round(sp.x * 10) / 10,
      y: sp.y,
      v: sp.value,
      effect: sp.effect,
    });
  }
  const nearbyObstacles: ErrorReport["nearbyObstacles"] = [];
  for (let i = 0; i < w.currentTrack.obstacles.length; i++) {
    if (w.destroyedObstacles[i]) continue;
    const o = w.currentTrack.obstacles[i]!;
    if (o.x + o.width < nearbyXMin || o.x > nearbyXMax) continue;
    nearbyObstacles.push({
      x: o.x,
      width: o.width,
      height: o.height,
      yBottom: o.yBottom ?? 0,
    });
  }
  const report: ErrorReport = {
    ts: Date.now(),
    seed: bot.currentSeed,
    botIndex: bot.index,
    runCount: bot.runCount,
    tick: w.tick,
    trackId: w.currentTrack.id,
    trackLength: w.currentTrack.length,
    obstacle: {
      idx: w.lastCollision.obstacleIdx,
      x: obs.x,
      width: obs.width,
      height: obs.height,
      yBottom: obs.yBottom ?? 0,
    },
    runner: {
      x: Math.round(r.x * 10) / 10,
      y: Math.round(r.y * 10) / 10,
      vy: Math.round(r.vy),
      hp: Math.round(r.hp * 10) / 10,
      jumpsLeft: r.jumpsLeft,
      onGround: r.onGround,
      invincibleTicks: r.invincibleTicks,
      magnetTicks: r.magnetTicks,
      giantTicks: r.giantTicks,
      itemDashTicks: r.itemDashTicks,
    },
    skills: w.skills.map((s) => ({
      id: s.spec.id,
      activeTicks: s.activeTicks,
      cooldownTicks: s.cooldownTicks,
    })),
    loadout: {
      character: bot.loadout.character.id,
      pet: bot.loadout.pet?.id ?? "(없음)",
      equipment: bot.equippedInstances.map((it) => ({
        specId: it.specId,
        level: it.level,
      })),
    },
    jumpHistory: bot.jumpHistory.slice(),
    nearbyItems,
    nearbyObstacles,
  };
  errorReports.unshift(report);
  if (errorReports.length > ERROR_REPORTS_MAX) {
    errorReports = errorReports.slice(0, ERROR_REPORTS_MAX);
  }
  saveErrorReports();
  renderErrorButton();
  if (!errorModal.hidden) renderErrorLog();
}

function openErrorModal() {
  renderErrorLog();
  errorStatusEl.textContent = "";
  errorModal.hidden = false;
}
function closeErrorModal() {
  errorModal.hidden = true;
  errorStatusEl.textContent = "";
}
errorButton.addEventListener("click", openErrorModal);
errorCloseButton.addEventListener("click", closeErrorModal);
errorModal.addEventListener("click", (e) => {
  if (e.target === errorModal) closeErrorModal();
});
errorCopyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(formatErrorLog());
    errorStatusEl.textContent = "전체 복사됨";
    setTimeout(() => {
      errorStatusEl.textContent = "";
    }, 2000);
  } catch {
    errorStatusEl.textContent = "복사 실패 — textarea에서 직접 선택해 복사";
  }
});
errorClearButton.addEventListener("click", () => {
  if (!window.confirm("모든 에러리포트를 삭제할까요?")) return;
  errorReports = [];
  saveErrorReports();
  renderErrorButton();
  renderErrorLog();
});
renderErrorButton();

// === 디버그 시드 모달 ===
const debugButton = document.getElementById("debug-button") as HTMLButtonElement;
const debugModal = document.getElementById("debug-modal")!;
const debugCloseButton = document.getElementById(
  "debug-close",
) as HTMLButtonElement;
const debugSeedInput = document.getElementById(
  "debug-seed",
) as HTMLInputElement;
const debugBotSelect = document.getElementById(
  "debug-bot",
) as HTMLSelectElement;
const debugLaunchButton = document.getElementById(
  "debug-launch",
) as HTMLButtonElement;
const debugStatusEl = document.getElementById("debug-status")!;

function fillDebugBotOptions() {
  debugBotSelect.innerHTML = "";
  for (const b of bots) {
    const opt = document.createElement("option");
    opt.value = String(b.index);
    opt.textContent = `봇 ${b.index + 1}`;
    debugBotSelect.appendChild(opt);
  }
}

function openDebugModal() {
  fillDebugBotOptions();
  debugStatusEl.textContent = "";
  debugModal.hidden = false;
}
function closeDebugModal() {
  debugModal.hidden = true;
  debugStatusEl.textContent = "";
}
debugButton.addEventListener("click", openDebugModal);
debugCloseButton.addEventListener("click", closeDebugModal);
debugModal.addEventListener("click", (e) => {
  if (e.target === debugModal) closeDebugModal();
});
debugLaunchButton.addEventListener("click", () => {
  const seed = Number(debugSeedInput.value);
  if (!Number.isFinite(seed)) {
    debugStatusEl.textContent = "유효한 숫자 시드 입력 필요";
    return;
  }
  const botIdx = Number(debugBotSelect.value);
  const bot = bots[botIdx];
  if (!bot) {
    debugStatusEl.textContent = "봇 선택 오류";
    return;
  }
  if (bot.status !== "lobby") {
    debugStatusEl.textContent = `봇 ${botIdx + 1}이 이미 주행 중 — 먼저 "뒤로"로 멈춰주세요`;
    return;
  }
  startBot(bot, Math.floor(seed));
  closeDebugModal();
});

// === 상점 모달 ===
const shopModal = document.getElementById("shop-modal")!;
const shopButton = document.getElementById("shop-button") as HTMLButtonElement;
const shopCloseButton = document.getElementById(
  "shop-close",
) as HTMLButtonElement;
const shopMessageEl = document.getElementById("shop-message")!;
const gachaPoolEl = document.getElementById("gacha-pool")!;
const gachaCostEl = document.getElementById("gacha-cost")!;
const gachaButton = document.getElementById("gacha-button") as HTMLButtonElement;
const bagCurrentEl = document.getElementById("bag-current")!;
const expandCostEl = document.getElementById("expand-cost")!;
const expandButton = document.getElementById(
  "expand-button",
) as HTMLButtonElement;

let shopMessageClearTimer: number | null = null;
function setShopMessage(msg: string) {
  shopMessageEl.textContent = msg;
  if (shopMessageClearTimer !== null) clearTimeout(shopMessageClearTimer);
  if (msg) {
    shopMessageClearTimer = window.setTimeout(() => {
      shopMessageEl.textContent = "";
      shopMessageClearTimer = null;
    }, 3000);
  }
}

function renderShop() {
  const poolNames = allEquipmentSpecs()
    .map((s) => s.name)
    .join(" / ");
  gachaPoolEl.textContent = `풀: ${poolNames}`;
  gachaCostEl.textContent = String(GACHA_COST);
  bagCurrentEl.textContent = `${inventory.bagItems.length}/${inventory.maxBagSize}`;
  const expandCost = bagExpandCost(inventory.maxBagSize);
  expandCostEl.textContent = String(expandCost);

  const bagFull = !hasBagSpace(inventory);
  gachaButton.disabled = totalCoins < GACHA_COST || bagFull;
  gachaButton.textContent = bagFull ? "가방 가득" : "뽑기";
  expandButton.disabled = totalCoins < expandCost;
  expandButton.textContent = `+${BAG_EXPAND_STEP}칸`;
}

function openShop() {
  shopModal.hidden = false;
  renderShop();
}
function closeShop() {
  shopModal.hidden = true;
  setShopMessage("");
}

shopButton.addEventListener("click", openShop);
shopCloseButton.addEventListener("click", closeShop);
shopModal.addEventListener("click", (e) => {
  // 배경 클릭 시 닫기 (모달 내용 클릭은 통과)
  if (e.target === shopModal) closeShop();
});

gachaButton.addEventListener("click", () => {
  if (totalCoins < GACHA_COST) return;
  if (!hasBagSpace(inventory)) {
    setShopMessage("가방이 가득 찼습니다");
    return;
  }
  const drawn = gachaDraw(inventory);
  if (!drawn) return;
  totalCoins -= GACHA_COST;
  saveTotalCoins(totalCoins);
  saveInventory(inventory);
  renderTotalCoins();
  renderShop();
  renderAllLobbyPanels();
  const spec = lookupSpec(drawn.specId);
  setShopMessage(`획득: ${spec?.name ?? "(알 수 없음)"}`);
});

expandButton.addEventListener("click", () => {
  const cost = bagExpandCost(inventory.maxBagSize);
  if (totalCoins < cost) return;
  expandBag(inventory);
  totalCoins -= cost;
  saveTotalCoins(totalCoins);
  saveInventory(inventory);
  renderTotalCoins();
  renderShop();
  renderAllLobbyPanels();
  setShopMessage(`가방이 ${BAG_EXPAND_STEP}칸 늘었습니다 (${inventory.maxBagSize}칸)`);
});

// === 캐릭터/펫 선택 모달 ===
const selectModal = document.getElementById("select-modal")!;
const selectModalTitle = document.getElementById("select-modal-title")!;
const selectListEl = document.getElementById("select-list")!;
const selectCloseButton = document.getElementById(
  "select-close",
) as HTMLButtonElement;

type SelectKind = "character" | "pet";
let selectContext: { botIdx: number; kind: SelectKind } | null = null;

function openSelectModal(bot: Bot, kind: SelectKind) {
  selectContext = { botIdx: bot.index, kind };
  renderSelectModal();
  selectModal.hidden = false;
}

function closeSelectModal() {
  selectModal.hidden = true;
  selectContext = null;
}

function renderSelectModal() {
  if (!selectContext) return;
  const { botIdx, kind } = selectContext;
  const botLabel = `봇 ${botIdx + 1}`;
  if (kind === "character") {
    selectModalTitle.textContent = `${botLabel} — 캐릭터 선택`;
    const currentId = inventory.botCharacterId[botIdx];
    const items = allCharacters().map((c) => {
      const detail: string[] = [
        `속도 ${c.runSpeed} / 점프 ${c.jumpVelocity}`,
        `체력 ${c.maxHp} / 점프 ${c.maxJumps}회`,
      ];
      if (c.skill) detail.push(`스킬: ${c.skill.id}`);
      if (c.coinPerDistance) detail.push(`패시브: ${c.coinPerDistance}거리당 코인 1`);
      const isCurrent = c.id === currentId;
      return `<div class="select-item ${isCurrent ? "current" : ""}" data-id="${escapeHtml(c.id)}">
        <div class="name">${escapeHtml(c.name)}${isCurrent ? ` <span class="badge">현재</span>` : ""}</div>
        <div class="detail">${escapeHtml(detail.join("\n"))}</div>
      </div>`;
    });
    selectListEl.innerHTML = items.join("");
  } else {
    selectModalTitle.textContent = `${botLabel} — 펫 선택`;
    const currentId = inventory.botPetId[botIdx];
    const noneCurrent = currentId === null;
    const noneItem = `<div class="select-item ${noneCurrent ? "current" : ""}" data-id="">
      <div class="name">(없음)${noneCurrent ? ` <span class="badge">현재</span>` : ""}</div>
      <div class="detail">펫 효과 없음</div>
    </div>`;
    const items = allPets().map((p) => {
      // description(자연어 설명)이 있으면 그걸 우선 표시. 없으면 기존 fallback.
      const descLine =
        p.description ??
        (p.skill ? `스킬: ${p.skill.id}` : "(효과 없음)");
      const detail = p.skill
        ? `${descLine}\n쿨 ${p.skill.cooldown}초`
        : descLine;
      const isCurrent = p.id === currentId;
      return `<div class="select-item ${isCurrent ? "current" : ""}" data-id="${escapeHtml(p.id)}">
        <div class="name">${escapeHtml(p.name)}${isCurrent ? ` <span class="badge">현재</span>` : ""}</div>
        <div class="detail">${escapeHtml(detail)}</div>
      </div>`;
    });
    selectListEl.innerHTML = [noneItem, ...items].join("");
  }

  selectListEl
    .querySelectorAll<HTMLElement>(".select-item")
    .forEach((el) => el.addEventListener("click", () => onSelectPick(el)));
}

function onSelectPick(el: HTMLElement) {
  if (!selectContext) return;
  const { botIdx, kind } = selectContext;
  const id = el.dataset.id ?? "";
  if (kind === "character") {
    if (!setBotCharacter(inventory, botIdx, id)) return;
  } else {
    const petId = id === "" ? null : id;
    if (!setBotPet(inventory, botIdx, petId)) return;
  }
  saveInventory(inventory);
  closeSelectModal();
  renderAllLobbyPanels();
}

selectCloseButton.addEventListener("click", closeSelectModal);
selectModal.addEventListener("click", (e) => {
  if (e.target === selectModal) closeSelectModal();
});

const GROUND_Y = 240;
const RUNNER_SCREEN_X = 100;
const CANVAS_W = 800;
const CANVAS_H = 300;
const TRAIL_LENGTH = 6;

// ==== 캐릭터 스프라이트 세트 ====
// 캐릭터별 달리기·슬라이드·점프 스프라이트를 세트로 묶는다. 렌더 코드가 봇의
// character.spriteId(생략 시 character.id)로 세트를 조회해 사용.
// 새 캐릭터 추가 흐름: IMG/characters/<id>/{run,slide,jump,portrait}.png 넣기 →
// 프레임 좌표 실측(tools/analyze_*.mjs) → 아래에 SpriteSetConfig 하나 추가 →
// CHARACTER_SPRITE_SETS에 등록.
// Vite가 `new URL(..., import.meta.url)`로 asset URL 변환해 번들 처리.
interface CatFrame {
  x: number;
  w: number;
  bot: number; // 시트 절대 좌표
}
interface SlideFrame {
  x: number;
  w: number;
  bot: number; // 프레임 로컬 발끝 y
}

// 눈 등 내부에 알파 0인 픽셀이 있는 이미지에서 배경 비침을 막기 위해,
// 외곽부터 flood fill로 진짜 배경만 마킹 → 마킹 안 된 알파 0 픽셀(내부 구멍)만 검게 채움.
function fillInternalHoles(img: HTMLImageElement): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cctx = c.getContext("2d")!;
  cctx.drawImage(img, 0, 0);
  const data = cctx.getImageData(0, 0, w, h);
  const d = data.data;
  const marked = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryPush = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (marked[p]) return;
    if (d[p * 4 + 3] !== 0) return;
    marked[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) {
    tryPush(x, 0);
    tryPush(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    tryPush(0, y);
    tryPush(w - 1, y);
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    tryPush(x - 1, y);
    tryPush(x + 1, y);
    tryPush(x, y - 1);
    tryPush(x, y + 1);
  }
  for (let p = 0; p < w * h; p++) {
    if (!marked[p] && d[p * 4 + 3] === 0) {
      const i = p * 4;
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      d[i + 3] = 255;
    }
  }
  cctx.putImageData(data, 0, 0);
  return c;
}

interface SpriteSetConfig {
  runFrames: CatFrame[];
  runSrcH: number;
  runPxPerFrame: number;
  slideFrames: SlideFrame[];
  slideSrcH: number;
  slidePxPerFrame: number;
  // 점프가 단일 프레임인 캐릭터는 launch·air 모두 같은 프레임 하나로 지정.
  jumpLaunchFrames: CatFrame[];
  jumpAirFrames: CatFrame[];
  jumpSrcH: number;
  jumpLaunchPxPerFrame: number;
  jumpAirPxPerFrame: number;
  // 점프 이미지 내부 구멍(눈 등) 채움 처리 필요 여부.
  jumpFillInternalHoles: boolean;
}

// 캐릭터 스프라이트 파일 로더. Vite의 new URL 정적 분석이 리터럴 조각 + 변수 조합만
// 처리하므로 종류(run/slide/jump)별로 함수를 분리해서 각 URL 리터럴을 명시.
// spriteId는 IMG/characters/<spriteId>/ 폴더명과 일치해야 함.
function loadCharacterRunImg(spriteId: string): HTMLImageElement {
  const img = new Image();
  img.src = new URL(
    `../../IMG/characters/${spriteId}/run.png`,
    import.meta.url,
  ).href;
  return img;
}
function loadCharacterSlideImg(spriteId: string): HTMLImageElement {
  const img = new Image();
  img.src = new URL(
    `../../IMG/characters/${spriteId}/slide.png`,
    import.meta.url,
  ).href;
  return img;
}
function loadCharacterJumpImg(spriteId: string): HTMLImageElement {
  const img = new Image();
  img.src = new URL(
    `../../IMG/characters/${spriteId}/jump.png`,
    import.meta.url,
  ).href;
  return img;
}

interface CharacterSpriteSet {
  runImg: HTMLImageElement;
  runReady: boolean;
  runFrames: CatFrame[];
  runSrcH: number;
  runPxPerFrame: number;
  slideImg: HTMLImageElement;
  slideReady: boolean;
  slideFrames: SlideFrame[];
  slideSrcH: number;
  slidePxPerFrame: number;
  jumpImg: HTMLImageElement;
  jumpReady: boolean;
  jumpDrawSource: CanvasImageSource;
  jumpLaunchFrames: CatFrame[];
  jumpAirFrames: CatFrame[];
  jumpSrcH: number;
  jumpLaunchPxPerFrame: number;
  jumpAirPxPerFrame: number;
  jumpLaunchDist: number;
}

function loadCharacterSpriteSet(
  spriteId: string,
  cfg: SpriteSetConfig,
): CharacterSpriteSet {
  const runImg = loadCharacterRunImg(spriteId);
  const slideImg = loadCharacterSlideImg(spriteId);
  const jumpImg = loadCharacterJumpImg(spriteId);
  const set: CharacterSpriteSet = {
    runImg,
    runReady: false,
    runFrames: cfg.runFrames,
    runSrcH: cfg.runSrcH,
    runPxPerFrame: cfg.runPxPerFrame,
    slideImg,
    slideReady: false,
    slideFrames: cfg.slideFrames,
    slideSrcH: cfg.slideSrcH,
    slidePxPerFrame: cfg.slidePxPerFrame,
    jumpImg,
    jumpReady: false,
    jumpDrawSource: jumpImg,
    jumpLaunchFrames: cfg.jumpLaunchFrames,
    jumpAirFrames: cfg.jumpAirFrames,
    jumpSrcH: cfg.jumpSrcH,
    jumpLaunchPxPerFrame: cfg.jumpLaunchPxPerFrame,
    jumpAirPxPerFrame: cfg.jumpAirPxPerFrame,
    jumpLaunchDist: cfg.jumpLaunchFrames.length * cfg.jumpLaunchPxPerFrame,
  };
  runImg.onload = () => {
    set.runReady = true;
  };
  slideImg.onload = () => {
    set.slideReady = true;
  };
  jumpImg.onload = () => {
    if (cfg.jumpFillInternalHoles) set.jumpDrawSource = fillInternalHoles(jumpImg);
    set.jumpReady = true;
  };
  return set;
}

// --- 황태 (주황 태비, 기본 캐릭터) ---
// 달리기: 2400×1350, 7행 × 7열 = 49프레임 (프레임별 실측).
// 슬라이드: 951×262, 하단 6프레임 사용 (상단은 도약/공격 자세).
// 점프: 1433×2400, 1행 5프레임 이륙 원샷 → 2행 앞 4프레임 공중 루프.
const HWANGTAE_SPRITES = loadCharacterSpriteSet("hwangtae", {
  runFrames: [
    { x: 114, w: 109, bot: 126 },
    { x: 458, w: 108, bot: 127 },
    { x: 802, w: 108, bot: 127 },
    { x: 1147, w: 105, bot: 127 },
    { x: 1491, w: 104, bot: 127 },
    { x: 1834, w: 104, bot: 127 },
    { x: 2177, w: 103, bot: 127 },
    { x: 120, w: 104, bot: 320 },
    { x: 463, w: 104, bot: 320 },
    { x: 805, w: 105, bot: 319 },
    { x: 1146, w: 106, bot: 319 },
    { x: 1488, w: 107, bot: 319 },
    { x: 1831, w: 107, bot: 319 },
    { x: 2175, w: 106, bot: 320 },
    { x: 120, w: 104, bot: 513 },
    { x: 464, w: 103, bot: 513 },
    { x: 807, w: 102, bot: 513 },
    { x: 1150, w: 102, bot: 513 },
    { x: 1492, w: 103, bot: 513 },
    { x: 1834, w: 104, bot: 513 },
    { x: 2177, w: 104, bot: 513 },
    { x: 118, w: 106, bot: 705 },
    { x: 460, w: 106, bot: 704 },
    { x: 802, w: 107, bot: 705 },
    { x: 1144, w: 108, bot: 705 },
    { x: 1487, w: 108, bot: 704 },
    { x: 1831, w: 107, bot: 706 },
    { x: 2176, w: 105, bot: 706 },
    { x: 120, w: 104, bot: 899 },
    { x: 464, w: 102, bot: 899 },
    { x: 807, w: 102, bot: 899 },
    { x: 1149, w: 103, bot: 899 },
    { x: 1491, w: 104, bot: 899 },
    { x: 1834, w: 104, bot: 898 },
    { x: 2176, w: 105, bot: 897 },
    { x: 117, w: 107, bot: 1090 },
    { x: 459, w: 107, bot: 1090 },
    { x: 801, w: 108, bot: 1090 },
    { x: 1145, w: 107, bot: 1091 },
    { x: 1489, w: 106, bot: 1092 },
    { x: 1834, w: 104, bot: 1092 },
    { x: 2178, w: 103, bot: 1092 },
    { x: 121, w: 103, bot: 1285 },
    { x: 464, w: 102, bot: 1285 },
    { x: 806, w: 103, bot: 1285 },
    { x: 1148, w: 104, bot: 1284 },
    { x: 1490, w: 105, bot: 1283 },
    { x: 1832, w: 106, bot: 1283 },
    { x: 2173, w: 108, bot: 1283 },
  ],
  runSrcH: 76,
  runPxPerFrame: 8,
  slideFrames: [
    { x: 9, w: 147, bot: 232 },
    { x: 166, w: 146, bot: 232 },
    { x: 323, w: 147, bot: 230 },
    { x: 481, w: 146, bot: 231 },
    { x: 639, w: 144, bot: 231 },
    { x: 796, w: 147, bot: 233 },
  ],
  slideSrcH: 55,
  slidePxPerFrame: 20,
  jumpLaunchFrames: [
    { x: 0, w: 274, bot: 317 },
    { x: 292, w: 262, bot: 337 },
    { x: 602, w: 228, bot: 343 },
    { x: 868, w: 245, bot: 342 },
    { x: 1154, w: 244, bot: 340 },
  ],
  jumpAirFrames: [
    { x: 23, w: 227, bot: 801 },
    { x: 314, w: 223, bot: 787 },
    { x: 597, w: 226, bot: 783 },
    { x: 881, w: 228, bot: 781 },
  ],
  jumpSrcH: 272,
  jumpLaunchPxPerFrame: 10,
  jumpAirPxPerFrame: 20,
  jumpFillInternalHoles: true,
});

// --- 머루 (회색 태비) ---
// 달리기: 678×368, 5행 × 5열 = 25프레임 (실측).
// 슬라이드: 951×262, 2행 × 6열 = 12프레임 (실측, 상·하단 모두 슬라이드 자세).
// 점프: 677×369, 단일 프레임. 이륙·공중 모두 같은 프레임 재사용.
const MERU_SPRITES = loadCharacterSpriteSet("meru", {
  runFrames: [
    { x: 21, w: 87, bot: 68 },
    { x: 159, w: 85, bot: 68 },
    { x: 286, w: 99, bot: 66 },
    { x: 418, w: 106, bot: 58 },
    { x: 556, w: 99, bot: 68 },
    { x: 15, w: 96, bot: 142 },
    { x: 154, w: 91, bot: 138 },
    { x: 295, w: 86, bot: 142 },
    { x: 421, w: 100, bot: 141 },
    { x: 553, w: 105, bot: 137 },
    { x: 13, w: 99, bot: 215 },
    { x: 150, w: 96, bot: 215 },
    { x: 290, w: 91, bot: 214 },
    { x: 431, w: 88, bot: 216 },
    { x: 556, w: 103, bot: 210 },
    { x: 11, w: 101, bot: 289 },
    { x: 150, w: 96, bot: 290 },
    { x: 286, w: 95, bot: 283 },
    { x: 430, w: 87, bot: 290 },
    { x: 559, w: 99, bot: 289 },
    { x: 11, w: 104, bot: 360 },
    { x: 150, w: 97, bot: 363 },
    { x: 286, w: 95, bot: 358 },
    { x: 429, w: 88, bot: 363 },
    { x: 558, w: 98, bot: 362 },
  ],
  runSrcH: 70,
  runPxPerFrame: 24, // 25프레임 사이클 체감 속도. 6→12→24 순으로 늦춤.
  slideFrames: [
    { x: 8, w: 141, bot: 125 },
    { x: 164, w: 143, bot: 125 },
    { x: 324, w: 144, bot: 125 },
    { x: 483, w: 143, bot: 126 },
    { x: 642, w: 145, bot: 126 },
    { x: 802, w: 141, bot: 125 },
    { x: 7, w: 143, bot: 242 },
    { x: 165, w: 142, bot: 242 },
    { x: 325, w: 142, bot: 241 },
    { x: 482, w: 143, bot: 242 },
    { x: 642, w: 143, bot: 242 },
    { x: 800, w: 143, bot: 242 },
  ],
  slideSrcH: 70,
  slidePxPerFrame: 12, // 12프레임 사이클 유지.
  jumpLaunchFrames: [{ x: 221, w: 251, bot: 366 }],
  jumpAirFrames: [{ x: 221, w: 251, bot: 366 }],
  jumpSrcH: 360,
  jumpLaunchPxPerFrame: 10,
  jumpAirPxPerFrame: 20,
  jumpFillInternalHoles: false,
});

const CHARACTER_SPRITE_SETS: Record<string, CharacterSpriteSet> = {
  hwangtae: HWANGTAE_SPRITES,
  meru: MERU_SPRITES,
};

// 캐릭터의 스프라이트 세트 조회. spriteId 생략 시 id 그대로 사용.
function characterSpriteSet(
  character: CharacterSpec,
): CharacterSpriteSet | undefined {
  const key = character.spriteId ?? character.id;
  return CHARACTER_SPRITE_SETS[key];
}

// 장애물 스프라이트 — low(웅덩이)·high(화분)·ceiling(샹들리에). platform은 별도.
// 캔버스 비율은 hitbox 비율과 맞지만 컨텐츠 아래·위 여백이 있어 dy를 밀어 지면 정렬.
interface ObstacleSpriteMeta {
  img: HTMLImageElement;
  // 캔버스 안 실 컨텐츠 하단 여백(px) / 캔버스 높이(px). 지면 obstacle에서 이 값만큼
  // dy를 아래로 밀면 실 컨텐츠 하단이 지면(GROUND_Y)에 딱 붙음.
  bottomMarginRatio: number;
}
function loadObstacleSprite(name: string): HTMLImageElement {
  const img = new Image();
  img.src = new URL(`../../IMG/obstacles/${name}.png`, import.meta.url).href;
  return img;
}
// 하단 여백 실측값 (tools/analyze_obstacle_sprites.mjs).
// 웅덩이는 가장 넓은 부분(y=194)이 지면과 정렬돼야 좌우 끝이 공중에 안 뜸 →
// bottomMarginRatio = (캔버스 h - 가장 넓은 y) / 캔버스 h = (388-194)/388 = 0.5.
// 결과: 웅덩이 위 절반은 지면 위, 아래 절반은 지면 밑으로 잠겨 자연스러움
// (obstacle이 지면 fillRect 뒤에 그려지므로 지면 덮음 = "레이어 앞").
const lowObstacleMeta: ObstacleSpriteMeta = {
  img: loadObstacleSprite("puddle"),
  bottomMarginRatio: 194 / 388,
};
const highObstacleMeta: ObstacleSpriteMeta = {
  img: loadObstacleSprite("pot"),
  bottomMarginRatio: 41 / 869,
};
// 샹들리에는 천장 매달림 — 하단 여백이 걸림 없이 자연스러우니 조정 X.
const airObstacleMeta: ObstacleSpriteMeta = {
  img: loadObstacleSprite("chandelier"),
  bottomMarginRatio: 0,
};
// 플랫폼(발판) — 서랍장 그림. 상단이 발판 면 = 봇 발끝이라 실 컨텐츠 bbox만
// crop해서 platform 사각형에 정확히 맞춤. 원본 여백(상 29 하 13 좌우 15)을
// 두면 서랍장·봇이 공중에 뜬 것처럼 보임.
const platformObstacleMeta: ObstacleSpriteMeta = {
  img: loadObstacleSprite("dresser"),
  bottomMarginRatio: 0,
};
// dresser.png(889×280) 알파 실측 bbox — 공중 부양 해소용.
const PLATFORM_SPRITE_CROP = { sx: 15, sy: 29, sw: 859, sh: 238 };

// 아이템 스프라이트 — heal·magnet·dash·giant. 로드 실패·기타 effect는 원 fallback.
function loadItemSprite(name: string): HTMLImageElement {
  const img = new Image();
  img.src = new URL(`../../IMG/items/${name}.png`, import.meta.url).href;
  return img;
}
// 각 스프라이트별 실제 내용 영역(bbox). 500×500 canvas 안 여백 다름 → 화면상 크기 불균일.
// 알파 분석 실측값으로 crop해 균일 크기로 그림.
interface ItemSpriteMeta {
  img: HTMLImageElement;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}
const itemSpriteHeal: ItemSpriteMeta = {
  img: loadItemSprite("heal"),
  sx: 90,
  sy: 90,
  sw: 319,
  sh: 319,
};
const itemSpriteMagnet: ItemSpriteMeta = {
  img: loadItemSprite("magnet"),
  sx: 60,
  sy: 62,
  sw: 380,
  sh: 378,
};
const itemSpriteDash: ItemSpriteMeta = {
  img: loadItemSprite("dash"),
  sx: 29,
  sy: 26,
  sw: 442,
  sh: 448,
};
const itemSpriteGiant: ItemSpriteMeta = {
  img: loadItemSprite("giant"),
  sx: 60,
  sy: 62,
  sw: 380,
  sh: 378,
};
function itemSpriteFor(
  effect: import("../sim/stage").ItemEffect | undefined,
): ItemSpriteMeta | null {
  if (effect === "heal") return itemSpriteHeal;
  if (effect === "magnet") return itemSpriteMagnet;
  if (effect === "dash") return itemSpriteDash;
  if (effect === "giant") return itemSpriteGiant;
  return null;
}

type BotStatus = "lobby" | "running";

interface Bot {
  index: number;
  loadout: Loadout;
  // 출발 시점 장착 인스턴스 스냅샷 — 인게임에서 강화 레벨 표시용.
  equippedInstances: ItemInstance[];
  status: BotStatus;
  world: World | null; // lobby 상태에서는 null
  runCount: number;
  endHandled: boolean;
  // 사망 후 재출발까지 남은 시뮬 틱. null이면 대기 중 아님.
  // 시뮬 시간 기준이라 방치 중 catch-up에서도 여러 사이클이 순차적으로 처리됨.
  respawnTicksLeft: number | null;
  // 사용자가 게임 중 "뒤로" 눌러 사이클을 강제 종료한 경우 true.
  // 결과창 대기가 끝나면 자동 재출발 대신 stopBot(로비 전환) 호출에 사용.
  userStopRequested: boolean;
  slotEl: HTMLElement; // data-status 토글되는 컨테이너
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  infoEl: HTMLElement;
  panelEl: HTMLElement; // 로비 패널
  statsEl: HTMLElement; // 세션 통계 라인
  dashTrail: { totalDistance: number; y: number }[];
  // 점프 이륙 시점 totalDistance. 착지(onGround)하면 null. 이단점프 시 새 값으로 덮어씀.
  jumpStartDistance: number | null;
  currentSeed: number | null; // 현재 진행 중 사이클의 시드 — 재현 디버그용
  // 충돌 시점 디버깅용 — 최근 몇 개 점프만 보관(메모리 절약)
  jumpHistory: {
    tick: number;
    x: number;
    y: number;
    vy: number;
    type: "단점프" | "이단점프";
  }[];
  // 세션 = startBot(로비에서) → stopBot(뒤로) 사이. 자동 재출발은 같은 세션.
  // 종료된 사이클의 누적값. 현재 사이클은 렌더 시 합산.
  sessionTicks: number;
  sessionDistance: number;
  sessionCoinsEarned: number;
}

const bots: Bot[] = [];
let frameRequested = false; // 게임 루프 활성 여부
let last = 0;
let accumulator = 0;

// --- 방치 후 따라잡기(catch-up) 설정 ---
// 탭이 백그라운드에 있는 동안 requestAnimationFrame이 멈춤. 재활성화 시
// document.visibilitychange 이벤트로 그 사이 흘러간 시간을 accumulator에 밀어 넣어
// 헤드리스로 시뮬 앞으로 감기. 렌더링은 그동안 스킵하고 오버레이만 갱신.
const MAX_CATCHUP_SECONDS = 60 * 60; // 최대 1시간까지만 따라잡음. 상수 하나로 나중에 확장 가능.
const MAX_TICKS_PER_FRAME = 600; // 한 프레임(=약 16ms)에 소화할 시뮬 틱 상한. 약 10초분.
const CATCHUP_OVERLAY_THRESHOLD_SEC = 1.0; // accumulator가 이보다 크면 오버레이 표시 + 렌더 스킵.
// 사망 → 재출발까지 시뮬 시간 대기. 정상 플레이에선 실물 5초 결과창 유지.
const RESPAWN_TICKS = Math.round(5 / TICK_DURATION);
let hiddenAt: number | null = null; // 탭이 숨겨진 시점(초 단위). null이면 현재 보이는 상태.
const catchupOverlayEl = document.getElementById("catchup-overlay") as HTMLElement | null;
const catchupRemainEl = document.getElementById("catchup-remain") as HTMLElement | null;

// 탭이 숨겨졌다가 다시 보일 때 그 사이 흐른 시간을 accumulator에 주입.
// 실행 중인 봇이 없으면 앞으로 감을 이유가 없으니 무시.
document.addEventListener("visibilitychange", () => {
  const now = performance.now() / 1000;
  if (document.hidden) {
    hiddenAt = now;
    return;
  }
  if (hiddenAt === null) return;
  const elapsed = Math.min(now - hiddenAt, MAX_CATCHUP_SECONDS);
  hiddenAt = null;
  if (!bots.some((b) => b.status === "running")) return;
  accumulator += elapsed;
  last = now;
  if (!frameRequested) {
    frameRequested = true;
    requestAnimationFrame(frame);
  }
});

// 시드 — 사이클마다 완전 랜덤(다양한 트랙·spawn·dash 타이밍 케이스 노출).
// 시뮬 자체는 결정론이라 충돌 케이스를 에러리포트로 캡처하면 디버그 모달로 그대로 재현 가능.
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function equipmentSummary(e: EquipmentSpec): string {
  const parts: string[] = [];
  if (e.runSpeedMult !== undefined && e.runSpeedMult !== 1)
    parts.push(`속도×${e.runSpeedMult}`);
  if (e.jumpVelocityMult !== undefined && e.jumpVelocityMult !== 1)
    parts.push(`점프×${e.jumpVelocityMult}`);
  if (e.healDashSeconds) parts.push(`회복대시 ${e.healDashSeconds}s`);
  if (e.coinValueMult !== undefined && e.coinValueMult !== 1)
    parts.push(`코인×${e.coinValueMult}`);
  return parts.join(", ");
}

function renderLobbyPanel(bot: Bot) {
  // 로비에선 아직 출발 안 했으므로 다음 사이클에 들어갈 로드아웃을 미리 계산해 표시.
  const previewLoadout = makeLoadout(bot.index);
  const character = previewLoadout.character;
  const pet = previewLoadout.pet;
  const charDetail: string[] = [
    `속도 ${character.runSpeed} / 점프 ${character.jumpVelocity}`,
    `체력 ${character.maxHp} / 점프 ${character.maxJumps}회`,
  ];
  if (character.skill) charDetail.push(`스킬: ${character.skill.id}`);
  if (character.coinPerDistance) {
    charDetail.push(`패시브: ${character.coinPerDistance}거리당 코인 1`);
  }

  const petName = pet?.name ?? "(없음)";
  const petDescLine = pet
    ? (pet.description ?? (pet.skill ? `스킬: ${pet.skill.id}` : "(효과 없음)"))
    : "";
  const petDetail = pet
    ? pet.skill
      ? `${petDescLine}\n쿨 ${pet.skill.cooldown}초`
      : petDescLine
    : "(효과 없음)";

  const slots = inventory.botEquipped[bot.index] ?? [];
  const slotHtml = slots
    .map((inst, i) => {
      if (!inst) {
        return `<div class="slot empty">
          <div class="slot-label">슬롯 ${i + 1}</div>
          <div class="slot-name">(비어 있음)</div>
        </div>`;
      }
      const eff = effectiveSpec(inst);
      const summary = eff ? equipmentSummary(eff) : "";
      const baseName = eff?.name ?? "(알 수 없음)";
      const levelTag = inst.level > 0 ? ` <span class="lv">+${inst.level}</span>` : "";
      const cost = enhanceCost(inst.level);
      const canEnhance = totalCoins >= cost;
      return `<div class="slot filled">
        <div class="slot-label">슬롯 ${i + 1}</div>
        <div class="slot-name">${escapeHtml(baseName)}${levelTag}</div>
        <div class="slot-detail">${escapeHtml(summary)}</div>
        <div class="slot-actions">
          <button class="small-button" data-action="unequip" data-slot="${i}">해제</button>
          <button class="small-button enhance" data-action="enhance-slot" data-slot="${i}" ${canEnhance ? "" : "disabled"}>강화 ${cost}</button>
        </div>
      </div>`;
    })
    .join("");

  const hasEmptySlot = firstEmptySlot(inventory, bot.index) >= 0;
  // 강화 레벨 내림차순(높은 거 위) → 종류(specId) → 인스턴스 id 순.
  const sortedBag = [...inventory.bagItems].sort((a, b) => {
    if (a.level !== b.level) return b.level - a.level;
    if (a.specId !== b.specId) return a.specId < b.specId ? -1 : 1;
    return a.id - b.id;
  });
  const bagHtml =
    sortedBag.length === 0
      ? `<div class="bag-empty">(가방 비어 있음)</div>`
      : sortedBag
          .map((it) => {
            const eff = effectiveSpec(it);
            const summary = eff ? equipmentSummary(eff) : "";
            const equipDisabled = hasEmptySlot ? "" : "disabled";
            const levelTag = it.level > 0 ? ` <span class="lv">+${it.level}</span>` : "";
            const cost = enhanceCost(it.level);
            const enhanceDisabled = totalCoins >= cost ? "" : "disabled";
            return `<div class="bag-item">
              <div class="bag-item-info">
                <span class="bag-item-name">${escapeHtml(eff?.name ?? "(알 수 없음)")}${levelTag}</span>
                <span class="bag-item-detail">${escapeHtml(summary)}</span>
              </div>
              <div class="bag-item-actions">
                <button class="small-button" data-action="equip" data-item="${it.id}" ${equipDisabled}>장착</button>
                <button class="small-button enhance" data-action="enhance-bag" data-item="${it.id}" ${enhanceDisabled}>강화 ${cost}</button>
                <button class="small-button danger" data-action="discard" data-item="${it.id}">삭제</button>
              </div>
            </div>`;
          })
          .join("");

  // 가방 스크롤 위치 보존 — innerHTML 통째 갱신으로 스크롤이 맨 위로 튀는 것을 막음.
  const prevBagScroll =
    bot.panelEl.querySelector<HTMLElement>(".bag")?.scrollTop ?? 0;

  bot.panelEl.innerHTML = `
    <div class="lobby-cards">
      <div class="card selectable" data-action="pick-character">
        <h3>캐릭터</h3>
        <div class="name">${escapeHtml(character.name)}</div>
        <div class="detail">${escapeHtml(charDetail.join("\n"))}</div>
      </div>
      <div class="card selectable" data-action="pick-pet">
        <h3>펫</h3>
        <div class="name">${escapeHtml(petName)}</div>
        <div class="detail">${escapeHtml(petDetail)}</div>
      </div>
    </div>
    <div class="inv-card">
      <h3>장착 슬롯 (${SLOT_COUNT})</h3>
      <div class="slots">${slotHtml}</div>
    </div>
    <div class="inv-card">
      <h3>가방 ${inventory.bagItems.length}/${inventory.maxBagSize}</h3>
      <div class="bag">${bagHtml}</div>
    </div>
    <button class="button" data-action="start">출발</button>
  `;

  const newBagEl = bot.panelEl.querySelector<HTMLElement>(".bag");
  if (newBagEl) newBagEl.scrollTop = prevBagScroll;

  bot.panelEl.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    el.addEventListener("click", () => handleLobbyAction(bot, el));
  });
}

function handleLobbyAction(bot: Bot, el: HTMLElement) {
  const action = el.dataset.action;
  if (action === "start") {
    startBot(bot);
    return;
  }
  if (action === "pick-character") {
    openSelectModal(bot, "character");
    return;
  }
  if (action === "pick-pet") {
    openSelectModal(bot, "pet");
    return;
  }
  if (action === "unequip") {
    const slot = Number(el.dataset.slot);
    if (unequipToBag(inventory, bot.index, slot)) {
      saveInventory(inventory);
      renderAllLobbyPanels();
      if (!shopModal.hidden) renderShop();
    }
    return;
  }
  if (action === "equip") {
    const itemId = Number(el.dataset.item);
    if (equipFromBag(inventory, bot.index, itemId)) {
      saveInventory(inventory);
      renderAllLobbyPanels();
      if (!shopModal.hidden) renderShop();
    }
    return;
  }
  if (action === "discard") {
    const itemId = Number(el.dataset.item);
    const target = inventory.bagItems.find((it) => it.id === itemId);
    if (!target) return;
    const spec = lookupSpec(target.specId);
    const name = spec?.name ?? "이 장비";
    if (!window.confirm(`${name}을(를) 삭제할까요? (복구 불가)`)) return;
    if (removeBagItem(inventory, itemId)) {
      saveInventory(inventory);
      renderAllLobbyPanels();
      if (!shopModal.hidden) renderShop();
    }
    return;
  }
  if (action === "enhance-slot") {
    const slot = Number(el.dataset.slot);
    const inst = inventory.botEquipped[bot.index]?.[slot];
    if (!inst) return;
    tryEnhance(inst);
    return;
  }
  if (action === "enhance-bag") {
    const itemId = Number(el.dataset.item);
    const inst = inventory.bagItems.find((it) => it.id === itemId);
    if (!inst) return;
    tryEnhance(inst);
    return;
  }
}

// 강화 시도 — 코인 검사, 차감, level++, 저장, UI 갱신.
function tryEnhance(inst: ItemInstance) {
  const cost = enhanceCost(inst.level);
  if (totalCoins < cost) return;
  totalCoins -= cost;
  enhanceInstance(inst);
  saveTotalCoins(totalCoins);
  saveInventory(inventory);
  renderTotalCoins();
  renderAllLobbyPanels();
  if (!shopModal.hidden) renderShop();
}

function renderAllLobbyPanels() {
  for (const b of bots) {
    if (b.status === "lobby") renderLobbyPanel(b);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function createBotSlots() {
  canvasContainer.innerHTML = "";
  bots.length = 0;
  for (let i = 0; i < BOT_COUNT; i++) {
    const slot = document.createElement("div");
    slot.className = "bot-slot";
    slot.dataset.status = "lobby";

    const header = document.createElement("div");
    header.className = "bot-slot-header";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = `봇 ${i + 1}`;
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "small-button";
    header.appendChild(title);
    header.appendChild(toggleBtn);
    slot.appendChild(header);

    const statsEl = document.createElement("div");
    statsEl.className = "bot-stats";
    statsEl.textContent = "세션 통계: 아직 출발 전";
    slot.appendChild(statsEl);

    const viewArea = document.createElement("div");
    viewArea.className = "view-area";
    slot.appendChild(viewArea);

    const gameView = document.createElement("div");
    gameView.className = "game-view";
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const info = document.createElement("div");
    info.className = "info";
    info.textContent = "준비 중…";
    gameView.appendChild(canvas);
    gameView.appendChild(info);
    viewArea.appendChild(gameView);

    const panel = document.createElement("div");
    panel.className = "lobby-view";
    viewArea.appendChild(panel);

    canvasContainer.appendChild(slot);

    const bot: Bot = {
      index: i,
      loadout: makeLoadout(i),
      equippedInstances: [],
      status: "lobby",
      world: null,
      runCount: 0,
      endHandled: false,
      respawnTicksLeft: null,
      userStopRequested: false,
      slotEl: slot,
      canvas,
      ctx: canvas.getContext("2d")!,
      infoEl: info,
      panelEl: panel,
      statsEl,
      dashTrail: [],
      jumpStartDistance: null,
      currentSeed: null,
      jumpHistory: [],
      sessionTicks: 0,
      sessionDistance: 0,
      sessionCoinsEarned: 0,
    };
    bots.push(bot);

    // 상단 토글 버튼 — 상태에 따라 동작이 다름
    toggleBtn.addEventListener("click", () => toggleBot(bot));

    renderLobbyPanel(bot);
    syncToggleButton(bot);
  }
}

function syncToggleButton(bot: Bot) {
  const btn = bot.slotEl.querySelector<HTMLButtonElement>(
    ".bot-slot-header .small-button",
  )!;
  btn.textContent = bot.status === "running" ? "뒤로" : "(대기 중)";
  btn.disabled = bot.status === "lobby";
}

function setBotStatus(bot: Bot, status: BotStatus) {
  bot.status = status;
  bot.slotEl.dataset.status = status;
  syncToggleButton(bot);
}

function toggleBot(bot: Bot) {
  if (bot.status !== "running") return;
  // lobby 상태에서는 "출발"은 패널 안 버튼이 담당 — 토글 버튼은 비활성.

  // 봇 사이클 도중이면 즉시 로비로 가지 않고 사망 처리 → 결과창 5초 노출 → 자동 로비.
  // 결과창 보는 중(이미 사망)에 한 번 더 눌리면 timer 취소 + 즉시 로비.
  if (bot.world && bot.world.runner.alive) {
    bot.userStopRequested = true;
    bot.world.runner.hp = 0;
    bot.world.runner.alive = false;
    return;
  }
  stopBot(bot);
}

function startBot(bot: Bot, customSeed?: number) {
  // 로비 상태에서 호출됐으면 새 세션 시작 (통계 리셋).
  // 5초 자동 재출발(running 상태에서 호출)이면 누적 유지.
  if (bot.status === "lobby") {
    bot.sessionTicks = 0;
    bot.sessionDistance = 0;
    bot.sessionCoinsEarned = 0;
  }
  bot.runCount++;
  // 출발 시점의 인벤토리로 로드아웃·인스턴스 스냅샷 확정.
  // 주행 중에 다른 봇이 인벤토리를 만져도 영향 없음.
  bot.loadout = makeLoadout(bot.index);
  bot.equippedInstances = (inventory.botEquipped[bot.index] ?? [])
    .filter((x): x is ItemInstance => x !== null)
    .map((x) => ({ ...x }));
  // customSeed가 주어지면 그대로 사용(디버그용). 자동 재출발은 매번 새 랜덤 시드.
  bot.currentSeed = customSeed !== undefined ? customSeed : randomSeed();
  bot.world = createWorld(bot.currentSeed, trackPool, bot.loadout);
  bot.jumpHistory.length = 0;
  bot.endHandled = false;
  bot.userStopRequested = false;
  bot.dashTrail.length = 0;
  bot.jumpStartDistance = null;
  bot.respawnTicksLeft = null;
  setBotStatus(bot, "running");
  ensureFrameLoop();
}

function stopBot(bot: Bot) {
  bot.respawnTicksLeft = null;
  // 도중 중단(생존 중)이면 사이클 시간·거리는 세션에 합산(코인은 사망 적립 규칙이라 잃음).
  // 이미 사망 처리된 사이클은 frame()에서 누적 완료된 상태.
  if (bot.world && bot.world.runner.alive) {
    bot.sessionTicks += bot.world.tick;
    bot.sessionDistance += bot.world.runner.totalDistance;
  }
  bot.world = null;
  bot.endHandled = false;
  bot.userStopRequested = false;
  bot.dashTrail.length = 0;
  bot.currentSeed = null;
  setBotStatus(bot, "lobby");
  renderLobbyPanel(bot);
  renderStats(bot);
}

function ensureFrameLoop() {
  if (frameRequested) return;
  if (!bots.some((b) => b.status === "running")) return;
  frameRequested = true;
  last = performance.now() / 1000;
  accumulator = 0;
  requestAnimationFrame(frame);
}

createBotSlots();

// 장비 coinValueMult 누적 — 결과창에서만 적용.
// 합연산: coinValueMult=1.1을 "+10%"로 해석해 보너스 합산. 무한 강화 시 곱셈 폭주 방지.
function totalCoinMult(loadout: Loadout): number {
  let bonus = 0;
  for (const e of loadout.equipment) {
    if (e.coinValueMult !== undefined) bonus += e.coinValueMult - 1;
  }
  return 1 + bonus;
}

function formatTime(totalSeconds: number): string {
  const mm = Math.floor(totalSeconds / 60);
  const ss = Math.floor(totalSeconds % 60);
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

// 봇 슬롯 헤더 아래 세션 통계 표시 — 시간/거리/코인/시간당 효율.
function renderStats(bot: Bot) {
  const w = bot.world;
  const cycleTicks = w ? w.tick : 0;
  const cycleDist = w ? w.runner.totalDistance : 0;
  // 진행 중 사이클의 잠재 코인은 사망 시점에 확정되니 표시 누적에는 미반영
  // (사용자가 도중 stopBot 하면 잃음 — 정확한 표시).
  const totalTicks = bot.sessionTicks + cycleTicks;
  const totalDist = bot.sessionDistance + cycleDist;
  const totalCoinsSession = bot.sessionCoinsEarned;
  const totalSec = totalTicks * TICK_DURATION;
  const coinsPerHour =
    totalSec > 0 ? Math.round((totalCoinsSession / totalSec) * 3600) : 0;
  if (totalTicks === 0) {
    bot.statsEl.textContent = "세션 통계: 아직 출발 전";
    return;
  }
  bot.statsEl.textContent =
    `세션  시간 ${formatTime(totalSec)}  |  거리 ${Math.floor(totalDist)}` +
    `  |  적립 코인 ${totalCoinsSession}  |  시간당 ${coinsPerHour}`;
}

function drawResultOverlay(bot: Bot) {
  const ctx = bot.ctx;
  const world = bot.world!;
  const r = world.runner;
  const elapsed = world.tick * TICK_DURATION;
  const mult = totalCoinMult(bot.loadout);
  const finalCoins = Math.floor(r.coins * mult);

  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const boxW = 340;
  const boxH = 224;
  const boxX = Math.floor((CANVAS_W - boxW) / 2);
  const boxY = Math.floor((CANVAS_H - boxH) / 2);
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2);

  ctx.fillStyle = "#fff";
  ctx.font = "bold 20px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`봇 ${bot.index + 1} 사이클 종료`, boxX + boxW / 2, boxY + 30);

  ctx.font = "14px monospace";
  ctx.textAlign = "left";
  const tx = boxX + 28;
  let ty = boxY + 62;
  const line = 22;

  ctx.fillText(`사이클       ${r.lap}`, tx, ty);
  ty += line;
  ctx.fillText(`누적거리     ${Math.floor(r.totalDistance)}`, tx, ty);
  ty += line;
  ctx.fillText(`플레이시간   ${formatTime(elapsed)}`, tx, ty);
  ty += line;
  ctx.fillText(`획득코인     ${r.coins}`, tx, ty);
  ty += line;
  if (mult !== 1) {
    ctx.fillStyle = "#fc0";
    ctx.fillText(
      `최종코인     ${finalCoins}  (×${mult.toFixed(2)})`,
      tx,
      ty,
    );
  } else {
    ctx.fillText(`최종코인     ${finalCoins}`, tx, ty);
  }
  ty += line;
  ctx.fillStyle = "#888";
  ctx.font = "11px monospace";
  ctx.fillText(`시드 ${bot.currentSeed ?? "-"}`, tx, ty);

  ctx.textAlign = "start";
}

type ItemDrawStyle = {
  kind: "coin" | "effect";
  fill: string;
  stroke: string;
  radius: number;
  glyph?: string;
};

function itemStyle(item: { value?: number; effect?: import("../sim/stage").ItemEffect }): ItemDrawStyle {
  // 특수 아이템은 모두 동일 지름 (사용자 요청: 크기 일정).
  if (item.effect === "heal")
    return { kind: "effect", fill: "#f7a", stroke: "#a35", radius: 24, glyph: "♥" };
  if (item.effect === "magnet")
    return { kind: "effect", fill: "#a4d", stroke: "#629", radius: 24, glyph: "U" };
  if (item.effect === "dash")
    return { kind: "effect", fill: "#f73", stroke: "#a30", radius: 24, glyph: "⚡" };
  if (item.effect === "giant")
    return { kind: "effect", fill: "#ff5", stroke: "#aa0", radius: 24, glyph: "★" };
  const value = item.value ?? 1;
  if (value >= 20) return { kind: "coin", fill: "#c6f", stroke: "#73a", radius: 13 };
  if (value >= 5) return { kind: "coin", fill: "#f93", stroke: "#a40", radius: 10 };
  return { kind: "coin", fill: "#fc0", stroke: "#a80", radius: 8 };
}

// 아이템 렌더 헬퍼 — 스프라이트 있으면 사용, 없으면 원+글리프 fallback.
// (sx, groundY, worldY) 기반 — 크기에 따라 자동 위쪽 정렬해서 지면 items도 온전히 보임.
function drawItem(
  ctx: CanvasRenderingContext2D,
  sx: number,
  groundY: number,
  worldY: number,
  item: { value?: number; effect?: import("../sim/stage").ItemEffect },
) {
  const style = itemStyle(item);
  // item.y=0(지면)이면 아이템 하단이 groundY에, 공중이면 worldY만큼 위로.
  // 코인처럼 작은 것도, 큰 스프라이트도 동일 규칙으로 자연스러운 위치.
  const cy = groundY - worldY - style.radius;
  const sprite = itemSpriteFor(item.effect);
  if (sprite && sprite.img.complete && sprite.img.naturalWidth > 0) {
    // 스프라이트별 실 내용 bbox 만 crop해서 균일 크기로 그림.
    const size = style.radius * 2;
    ctx.drawImage(
      sprite.img,
      sprite.sx,
      sprite.sy,
      sprite.sw,
      sprite.sh,
      sx - size / 2,
      cy - size / 2,
      size,
      size,
    );
    return;
  }
  ctx.fillStyle = style.fill;
  ctx.strokeStyle = style.stroke;
  ctx.beginPath();
  ctx.arc(sx, cy, style.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (style.glyph) {
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${style.radius}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(style.glyph, sx, cy + 1);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }
}

function drawTrack(
  ctx: CanvasRenderingContext2D,
  track: Stage,
  trackStart: number,
  camX: number,
  itemSkipMask: boolean[] | null,
  destroyedMask: boolean[] | null = null,
) {
  for (let i = 0; i < track.obstacles.length; i++) {
    if (destroyedMask && destroyedMask[i]) continue;
    const o = track.obstacles[i]!;
    const wx = trackStart + o.x;
    const sx = wx - camX;
    if (sx + o.width < 0 || sx > CANVAS_W) continue;
    const yBottom = o.yBottom ?? 0;
    const yTop = yBottom + o.height;
    if (o.kind === "platform") {
      // 플랫폼 — dresser 스프라이트 사용. 로드 전이면 색깔 사각형 fallback.
      const meta = platformObstacleMeta;
      if (meta.img.complete && meta.img.naturalWidth > 0) {
        const c = PLATFORM_SPRITE_CROP;
        ctx.drawImage(
          meta.img,
          c.sx, c.sy, c.sw, c.sh,
          sx, GROUND_Y - yTop, o.width, o.height,
        );
      } else {
        ctx.fillStyle = "#8b6f47";
        ctx.fillRect(sx, GROUND_Y - yTop, o.width, 8);
        ctx.fillStyle = "rgba(139, 111, 71, 0.4)";
        ctx.fillRect(sx, GROUND_Y - yTop + 8, o.width, o.height - 8);
      }
    } else {
      // 지면 obstacle은 h=30(웅덩이) / h=150(화분), 천장 obstacle은 yBottom>0(샹들리에).
      // 스프라이트 로드 완료 시 사용, 아니면 색깔 사각형 fallback.
      let meta: ObstacleSpriteMeta | null = null;
      if (yBottom > 0) meta = airObstacleMeta;
      else if (o.height === 150) meta = highObstacleMeta;
      else if (o.height === 30) meta = lowObstacleMeta;
      if (meta && meta.img.complete && meta.img.naturalWidth > 0) {
        // dy를 하단 여백 비율만큼 아래로 밀어 실 컨텐츠 하단이 지면에 딱 붙게.
        const dyOffset = o.height * meta.bottomMarginRatio;
        ctx.drawImage(
          meta.img,
          sx,
          GROUND_Y - yTop + dyOffset,
          o.width,
          o.height,
        );
      } else {
        ctx.fillStyle = "#444";
        ctx.fillRect(sx, GROUND_Y - yTop, o.width, o.height);
      }
    }
  }

  // 구멍 — 트랙 ground 색 위에 검정으로 덮어 그리기
  const pits = track.pits ?? [];
  for (const pit of pits) {
    const wx = trackStart + pit.x;
    const sx = wx - camX;
    if (sx + pit.width < 0 || sx > CANVAS_W) continue;
    ctx.fillStyle = "#1a1410";
    ctx.fillRect(sx, GROUND_Y, pit.width, CANVAS_H - GROUND_Y);
  }

  ctx.lineWidth = 2;
  for (let i = 0; i < track.items.length; i++) {
    if (itemSkipMask !== null && itemSkipMask[i]) continue;
    const item = track.items[i]!;
    const wx = trackStart + item.x;
    const sx = wx - camX;
    if (sx < -40 || sx > CANVAS_W + 40) continue;
    drawItem(ctx, sx, GROUND_Y, item.y, item);
  }

  const boundarySx = trackStart + track.length - camX;
  if (boundarySx >= 0 && boundarySx <= CANVAS_W) {
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillRect(boundarySx, 0, 2, GROUND_Y);
  }
}

function renderBot(bot: Bot) {
  const ctx = bot.ctx;
  const world = bot.world!;

  ctx.fillStyle = "#87ceeb";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = "#5a3";
  ctx.fillRect(0, GROUND_Y, CANVAS_W, CANVAS_H - GROUND_Y);

  const camX = world.runner.totalDistance - RUNNER_SCREEN_X;

  if (world.prevTrack !== null) {
    drawTrack(ctx, world.prevTrack, world.prevTrackStart, camX, null);
  }
  drawTrack(
    ctx,
    world.currentTrack,
    world.currentTrackStart,
    camX,
    world.currentItemCollected,
    world.destroyedObstacles,
  );

  ctx.lineWidth = 2;
  for (const sp of world.spawnedItems) {
    if (sp.collected) continue;
    const wx = world.currentTrackStart + sp.x;
    const sx = wx - camX;
    if (sx < -40 || sx > CANVAS_W + 40) continue;
    drawItem(ctx, sx, GROUND_Y, sp.y, { value: sp.value, effect: sp.effect });
  }
  drawTrack(
    ctx,
    world.nextTrack,
    world.currentTrackStart + world.currentTrack.length,
    camX,
    null,
  );

  const r = world.runner;
  const spriteSet = characterSpriteSet(bot.loadout.character);
  const dashing =
    world.skills.some((s) => s.spec.id === "dash" && s.activeTicks > 0) ||
    r.itemDashTicks > 0;
  const invincible = r.invincibleTicks > 0;
  const blink = invincible && Math.floor(r.invincibleTicks / 6) % 2 === 0;

  if (dashing) {
    bot.dashTrail.push({ totalDistance: r.totalDistance, y: r.y });
    if (bot.dashTrail.length > TRAIL_LENGTH) bot.dashTrail.shift();
    // 잔상은 봇의 현재 스프라이트(달리기/슬라이드)에 맞춰서 흐리게 반복 렌더.
    const useSpriteTrail = !!spriteSet && spriteSet.runReady;
    for (let i = 0; i < bot.dashTrail.length; i++) {
      const ghost = bot.dashTrail[i]!;
      const alpha = (0.45 * (i + 1)) / bot.dashTrail.length;
      const offsetX = r.totalDistance - ghost.totalDistance;
      const sx = RUNNER_SCREEN_X - offsetX;
      const sy = GROUND_Y - ghost.y - r.height;
      if (useSpriteTrail && spriteSet) {
        ctx.globalAlpha = alpha;
        if (r.sliding && spriteSet.slideReady) {
          const sIdx =
            Math.floor(ghost.totalDistance / spriteSet.slidePxPerFrame) %
            spriteSet.slideFrames.length;
          const sf = spriteSet.slideFrames[sIdx]!;
          const srcY = sf.bot + 1 - spriteSet.slideSrcH;
          ctx.drawImage(
            spriteSet.slideImg,
            sf.x,
            srcY,
            sf.w,
            spriteSet.slideSrcH,
            sx,
            sy,
            r.width,
            r.height,
          );
        } else if (
          !r.onGround &&
          bot.jumpStartDistance !== null &&
          spriteSet.jumpReady
        ) {
          // 점프 중 대시 — 잔상도 점프 자세로. airDist는 ghost 시점 기준.
          const airDist = Math.max(
            0,
            ghost.totalDistance - bot.jumpStartDistance,
          );
          let jf: CatFrame;
          if (airDist < spriteSet.jumpLaunchDist) {
            jf =
              spriteSet.jumpLaunchFrames[
                Math.floor(airDist / spriteSet.jumpLaunchPxPerFrame)
              ]!;
          } else {
            const airIdx =
              Math.floor(
                (airDist - spriteSet.jumpLaunchDist) /
                  spriteSet.jumpAirPxPerFrame,
              ) % spriteSet.jumpAirFrames.length;
            jf = spriteSet.jumpAirFrames[airIdx]!;
          }
          const srcY = jf.bot + 1 - spriteSet.jumpSrcH;
          ctx.drawImage(
            spriteSet.jumpDrawSource,
            jf.x,
            srcY,
            jf.w,
            spriteSet.jumpSrcH,
            sx,
            sy,
            r.width,
            r.height,
          );
        } else {
          const fIdx =
            Math.floor(ghost.totalDistance / spriteSet.runPxPerFrame) %
            spriteSet.runFrames.length;
          const rf = spriteSet.runFrames[fIdx]!;
          const srcY = rf.bot + 1 - spriteSet.runSrcH;
          ctx.drawImage(
            spriteSet.runImg,
            rf.x,
            srcY,
            rf.w,
            spriteSet.runSrcH,
            sx,
            sy,
            r.width,
            r.height,
          );
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = `rgba(251, 179, 51, ${alpha})`;
        ctx.fillRect(sx, sy, r.width, r.height);
      }
    }
  } else {
    bot.dashTrail.length = 0;
  }

  if (r.magnetTicks > 0) {
    const cx = RUNNER_SCREEN_X + r.width / 2;
    const cy = GROUND_Y - r.y - r.height / 2;
    ctx.fillStyle = "rgba(170, 80, 220, 0.12)";
    ctx.beginPath();
    ctx.arc(cx, cy, 250, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(170, 80, 220, 0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 250, 0, Math.PI * 2);
    ctx.stroke();
  }

  const giant = r.giantTicks > 0;
  const dx = RUNNER_SCREEN_X;
  const dy = GROUND_Y - r.y - r.height;
  const useSprite = !!spriteSet && spriteSet.runReady;

  if (useSprite && spriteSet && r.alive && !(invincible && blink)) {
    if (r.sliding && spriteSet.slideReady) {
      // 슬라이드 — 캐릭터별 프레임 세트 순환. 발끝(bot)이 crop 하단에 오도록 srcY 결정.
      const sIdx =
        Math.floor(r.totalDistance / spriteSet.slidePxPerFrame) %
        spriteSet.slideFrames.length;
      const sf = spriteSet.slideFrames[sIdx]!;
      const srcY = sf.bot + 1 - spriteSet.slideSrcH;
      ctx.drawImage(
        spriteSet.slideImg,
        sf.x,
        srcY,
        sf.w,
        spriteSet.slideSrcH,
        dx,
        dy,
        r.width,
        r.height,
      );
    } else if (
      !r.onGround &&
      bot.jumpStartDistance !== null &&
      spriteSet.jumpReady
    ) {
      // 점프 — 이륙 원샷 재생 후 공중 유지 프레임 루프. 캐릭터가 단일 프레임이면
      // launch·air가 같은 프레임 하나로 세팅되어 있어 자연스럽게 유지됨.
      const airDist = r.totalDistance - bot.jumpStartDistance;
      let jf: CatFrame;
      if (airDist < spriteSet.jumpLaunchDist) {
        jf =
          spriteSet.jumpLaunchFrames[
            Math.floor(airDist / spriteSet.jumpLaunchPxPerFrame)
          ]!;
      } else {
        const airIdx =
          Math.floor(
            (airDist - spriteSet.jumpLaunchDist) / spriteSet.jumpAirPxPerFrame,
          ) % spriteSet.jumpAirFrames.length;
        jf = spriteSet.jumpAirFrames[airIdx]!;
      }
      const srcY = jf.bot + 1 - spriteSet.jumpSrcH;
      ctx.drawImage(
        spriteSet.jumpDrawSource,
        jf.x,
        srcY,
        jf.w,
        spriteSet.jumpSrcH,
        dx,
        dy,
        r.width,
        r.height,
      );
    } else {
      // 달리기 — 캐릭터별 프레임 세트 순환.
      const frameIndex =
        Math.floor(r.totalDistance / spriteSet.runPxPerFrame) %
        spriteSet.runFrames.length;
      const rf = spriteSet.runFrames[frameIndex]!;
      const srcY = rf.bot + 1 - spriteSet.runSrcH;
      ctx.drawImage(
        spriteSet.runImg,
        rf.x,
        srcY,
        rf.w,
        spriteSet.runSrcH,
        dx,
        dy,
        r.width,
        r.height,
      );
    }
  } else if (useSprite && r.alive && invincible && blink) {
    // 무적 블링크 프레임 — 그리기 skip (깜빡임 효과)
  } else {
    // 스프라이트 로딩 전·다른 캐릭터·사망: 기존 색깔 박스 fallback.
    if (!r.alive) ctx.fillStyle = "#888";
    else if (giant) ctx.fillStyle = "#ff5";
    else if (dashing) ctx.fillStyle = "#fb3";
    else if (blink) ctx.fillStyle = "#fcc";
    else ctx.fillStyle = "#e44";
    ctx.fillRect(dx, dy, r.width, r.height);
  }

  // === HUD ===

  const hpBarW = 220;
  const hpBarH = 22;
  const hpBarX = 10;
  const hpBarY = 10;
  const hpRatio = Math.max(0, r.hp / r.maxHp);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(hpBarX, hpBarY, hpBarW, hpBarH);
  ctx.fillStyle = hpRatio > 0.5 ? "#4d8" : hpRatio > 0.25 ? "#fd5" : "#f55";
  ctx.fillRect(hpBarX, hpBarY, hpBarW * hpRatio, hpBarH);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.strokeRect(hpBarX + 0.5, hpBarY + 0.5, hpBarW - 1, hpBarH - 1);
  ctx.fillStyle = "#fff";
  ctx.font = "13px monospace";
  ctx.fillText(
    `HP ${Math.ceil(r.hp)}/${r.maxHp}`,
    hpBarX + 8,
    hpBarY + 16,
  );

  for (let i = 0; i < world.skills.length; i++) {
    const skill = world.skills[i]!;
    const barW = 200;
    const barH = 18;
    const barX = CANVAS_W - barW - 10;
    const barY = 10 + i * (barH + 6);

    let progress: number;
    let fillColor: string;
    let label: string;
    if (skill.activeTicks > 0) {
      progress = skill.activeTicks / skill.durationTotalTicks;
      fillColor = "#fb3";
      label = `${skill.spec.id} 발동중`;
    } else {
      progress = 1 - skill.cooldownTicks / skill.cooldownTotalTicks;
      fillColor = "#69c";
      label = `${skill.spec.id} 쿨타임`;
    }

    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = fillColor;
    ctx.fillRect(barX, barY, barW * progress, barH);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
    ctx.fillStyle = "#fff";
    ctx.font = "12px monospace";
    ctx.fillText(label, barX + 6, barY + 13);
  }

  const parts = [
    bot.loadout.character.name,
    `시도 #${bot.runCount}`,
    `시드 ${bot.currentSeed ?? "-"}`,
    `사이클 ${r.lap}`,
    `현재트랙 ${world.currentTrack.id}`,
    `진행 ${Math.floor(r.x)}/${world.currentTrack.length}`,
    `누적코인 ${r.coins}`,
    `누적거리 ${Math.floor(r.totalDistance)}`,
  ];
  if (!r.alive) parts.push("사망");
  // 인게임에서도 현재 장착 장비·강화 레벨을 볼 수 있게 두 번째 줄에 표시.
  const eqNames = bot.equippedInstances
    .map((inst) => {
      const spec = lookupSpec(inst.specId);
      const lv = inst.level > 0 ? `+${inst.level}` : "";
      return `${spec?.name ?? "?"}${lv}`;
    })
    .join(" / ");
  bot.infoEl.textContent =
    parts.join("  |  ") +
    "\n장착: " +
    (eqNames || "(없음)");

  renderStats(bot);

  if (!r.alive) {
    drawResultOverlay(bot);
  }
}

function frame() {
  const runningBots = bots.filter((b) => b.status === "running");
  if (runningBots.length === 0) {
    frameRequested = false;
    if (catchupOverlayEl) catchupOverlayEl.hidden = true;
    return;
  }

  const now = performance.now() / 1000;
  // visibilitychange가 이미 accumulator에 흘러간 시간을 밀어 넣으므로 실전 dt는 작음.
  // 클램프는 이벤트 놓친 경우의 방어용.
  const dt = Math.min(now - last, MAX_CATCHUP_SECONDS);
  last = now;
  accumulator += dt;

  // 한 프레임에서 소화할 시뮬 틱 상한. 남은 accumulator는 다음 프레임으로 이월돼서
  // 브라우저가 얼지 않게 함.
  let ticksThisFrame = 0;
  while (accumulator >= TICK_DURATION && ticksThisFrame < MAX_TICKS_PER_FRAME) {
    for (const b of runningBots) {
      if (b.world && b.world.runner.alive) {
        const w = b.world;
        const prevJumps = w.runner.jumpsLeft;
        const xBefore = w.runner.x;
        const yBefore = w.runner.y;
        const vyBefore = w.runner.vy;
        const tickBefore = w.tick;
        step(w, decide(w));
        // 착지 순간 점프 애니메이션 리셋 — 다음 점프 발동 저장이 덮어쓰기 전에 처리.
        if (w.runner.onGround) b.jumpStartDistance = null;
        // 점프 발동 감지 (jumpsLeft 감소)
        if (w.runner.jumpsLeft < prevJumps) {
          const type: "단점프" | "이단점프" =
            prevJumps === w.runner.maxJumps ? "단점프" : "이단점프";
          b.jumpHistory.push({
            tick: tickBefore,
            x: Math.round(xBefore * 10) / 10,
            y: Math.round(yBefore * 10) / 10,
            vy: Math.round(vyBefore),
            type,
          });
          if (b.jumpHistory.length > 5) b.jumpHistory.shift();
          // 이륙 순간 totalDistance 기록 — 이단점프면 새로 덮어써서 1행 재재생.
          b.jumpStartDistance = w.runner.totalDistance;
        }
        // 충돌 발생 시 에러리포트 기록
        if (w.lastCollision) recordCollision(b);
      }
      // 방금 사망했으면 사이클 종료 처리 + 재출발 대기 카운터 세팅.
      // while 안에서 처리해야 catch-up 중에도 여러 사이클이 순차적으로 진행됨.
      if (b.world && !b.world.runner.alive && !b.endHandled) {
        b.endHandled = true;
        const earned = Math.floor(
          b.world.runner.coins * totalCoinMult(b.loadout),
        );
        if (earned > 0) {
          totalCoins += earned;
          saveTotalCoins(totalCoins);
          renderTotalCoins();
          if (!shopModal.hidden) renderShop();
        }
        b.sessionTicks += b.world.tick;
        b.sessionDistance += b.world.runner.totalDistance;
        b.sessionCoinsEarned += earned;
        b.respawnTicksLeft = RESPAWN_TICKS;
      }
      // 재출발 대기 카운터 감소. 0에 도달하면 재출발 또는 로비 전환.
      if (b.respawnTicksLeft !== null) {
        b.respawnTicksLeft--;
        if (b.respawnTicksLeft <= 0) {
          b.respawnTicksLeft = null;
          if (b.userStopRequested) stopBot(b);
          else startBot(b);
        }
      }
    }
    accumulator -= TICK_DURATION;
    ticksThisFrame++;
  }

  // 아직 소화할 시뮬 시간이 많이 남아있으면 "따라잡는 중" 상태로 보고
  // 렌더링은 스킵. 오버레이만 갱신해서 사용자에게 대기 안내.
  const catchingUp = accumulator >= CATCHUP_OVERLAY_THRESHOLD_SEC;

  for (const b of runningBots) {
    if (b.world && !catchingUp) renderBot(b);
  }

  if (catchupOverlayEl) {
    if (catchingUp) {
      catchupOverlayEl.hidden = false;
      if (catchupRemainEl) catchupRemainEl.textContent = accumulator.toFixed(1);
    } else {
      catchupOverlayEl.hidden = true;
    }
  }

  requestAnimationFrame(frame);
}
