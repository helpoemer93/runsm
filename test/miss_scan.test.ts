// 헤드리스 시드 스캐너 — N개 시드로 봇 빌드 시뮬 후 미스 패턴 통계 + top K 시드 출력.
// 일회성 분석 도구. 회귀에서 제외하려면 `npx vitest run --exclude test/miss_scan.test.ts ...`
// 또는 직접 `npx vitest run test/miss_scan.test.ts` 호출.
//
// KIND_FILTER로 특정 효과/가치만 필터. 봇이 item 가까이 도달한 시점 상태로 자동 분류
// → "의도" 케이스(면역/점프 다 씀 등) 제외하고 "?원인 미상" 케이스에서 진짜 픽스 대상 찾기.
//
// 워크플로: 스캐너로 ?원인미상 미스 많은 시드 발견 → trace.test.ts에 박아 자세히 분석 → 픽스.

import { describe, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";
import { Rng } from "../src/sim/rng";

import defaultChar from "../src/data/characters/hwangtae.json";
import coinWalkerChar from "../src/data/characters/meru.json";
import destroyerPet from "../src/data/pets/nurungji.json";
import fireworkPet from "../src/data/pets/geumbungeo.json";
import shoesSpec from "../src/data/equipment/shoes.json";
import healTalismanSpec from "../src/data/equipment/heal-talisman.json";
import coinRingSpec from "../src/data/equipment/coin-ring.json";

import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

// ── 입력 ───────────────────────────────────────────────
const SCAN_START_SEED = 42; // 시드 생성 RNG의 시작 시드 (결정론)
const SCAN_COUNT = 100;
const MAX_LAPS = 1;
const MAX_TICKS = 30000;
const TOP_K = 10;
const SAMPLES_PER_SEED = 5;
// 특정 미스 종류만 분석 (null = 모든 watched). 예: "heal", "dash", "magnet", "giant", "coin v=5", "coin v=20"
const KIND_FILTER: string | null = "heal";
const LOADOUT: Loadout = {
  character: coinWalkerChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};
// ───────────────────────────────────────────────────────

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

void [defaultChar, fireworkPet, shoesSpec, healTalismanSpec, coinRingSpec] as unknown as EquipmentSpec[];

// 미탐 1 스캔용 — 7개 로드아웃 (collision_stats_1000과 동일 구성)
const ALL_LOADOUTS: { label: string; loadout: Loadout }[] = [
  {
    label: "황태+누룽지",
    loadout: { character: defaultChar as CharacterSpec, pet: destroyerPet as PetSpec, equipment: [] },
  },
  {
    label: "황태+금붕어",
    loadout: { character: defaultChar as CharacterSpec, pet: fireworkPet as PetSpec, equipment: [] },
  },
  {
    label: "머루+누룽지",
    loadout: { character: coinWalkerChar as CharacterSpec, pet: destroyerPet as PetSpec, equipment: [] },
  },
  {
    label: "머루+금붕어",
    loadout: { character: coinWalkerChar as CharacterSpec, pet: fireworkPet as PetSpec, equipment: [] },
  },
  {
    label: "황태+누룽지+신발×3",
    loadout: {
      character: defaultChar as CharacterSpec,
      pet: destroyerPet as PetSpec,
      equipment: [shoesSpec as EquipmentSpec, shoesSpec as EquipmentSpec, shoesSpec as EquipmentSpec],
    },
  },
  {
    label: "황태+누룽지+회복부적×3",
    loadout: {
      character: defaultChar as CharacterSpec,
      pet: destroyerPet as PetSpec,
      equipment: [healTalismanSpec as EquipmentSpec, healTalismanSpec as EquipmentSpec, healTalismanSpec as EquipmentSpec],
    },
  },
  {
    label: "황태+누룽지+코인반지×3",
    loadout: {
      character: defaultChar as CharacterSpec,
      pet: destroyerPet as PetSpec,
      equipment: [coinRingSpec as EquipmentSpec, coinRingSpec as EquipmentSpec, coinRingSpec as EquipmentSpec],
    },
  },
  {
    label: "황태+금붕어+코인반지×3",
    loadout: {
      character: defaultChar as CharacterSpec,
      pet: fireworkPet as PetSpec,
      equipment: [coinRingSpec as EquipmentSpec, coinRingSpec as EquipmentSpec, coinRingSpec as EquipmentSpec],
    },
  },
];

function isWatched(item: { value?: number; effect?: string }): boolean {
  if (item.effect) return true;
  return (item.value ?? 1) >= 5;
}

function kindOf(item: { value?: number; effect?: string }): string {
  return item.effect ?? `coin v=${item.value ?? 1}`;
}

function singleJumpReach(c: CharacterSpec): number {
  return (c.jumpVelocity * c.jumpVelocity) / (2 * 2000) + c.height;
}

// 봇 접근 시점 스냅샷 — 봇이 item 가까이 (trigger 거리 안) 처음 도달한 시점 상태.
// 미스 발생 시 이 스냅샷을 보고 "왜 점프 안 했나" 분류.
interface ApproachSnapshot {
  tick: number;
  botX: number;
  botY: number;
  onGround: boolean;
  jumpsLeft: number;
  vy: number;
  immune: boolean; // dash·itemDash·giant·invincibleTicks 모두 포함
  debugReason: string; // 봇 판단 사유 (어느 branch에서 결정했는지)
  hasImminentHazard: boolean; // 봇 앞 근접 위험 (pit 또는 임박 지상 장애물)
  hazardKind: string; // 위험 종류 태그
  // 아이템 도달 가능 여부 — 봇 window 안 어느 시점이든 점프해서 잡을 수 있으면 true.
  // 이 값이 미스 판정 시점에 계속 갱신됨. 최종적으로 미스 판정 시 이 값으로 세분화.
  catchable: boolean;
}

// 물리 도달 계산 — 봇이 (x0, y0, vy0, onGround)에서 지금 점프 발동 시 아이템 (itemX, itemY) 잡는지.
// baseSpeed 기준 (dash 활성 무시 — approach 짧아서 근사).
function canCatchWithJumpNow(
  x0: number,
  y0: number,
  onGround: boolean,
  itemX: number,
  itemY: number,
  spec: CharacterSpec,
): boolean {
  const baseSpeed = spec.runSpeed;
  const jV = spec.jumpVelocity;
  const baseH = spec.height;
  const G = -2200;
  const t = (itemX - x0) / baseSpeed;
  if (t < 0) return false; // 이미 지남
  // 지상이든 공중이든 점프 발동 시 vy=jV로 재세팅
  void onGround;
  const y = y0 + jV * t + (G / 2) * t * t;
  return itemY >= y && itemY <= y + baseH;
}

// 미스 시점 봇 상태와 휴리스틱 분류 — 수집 점프는 면역 무관(디자인)이라 면역은 분류 기준 X.
// "지상가능(안전·도달가능)"  — 지상 + 점프 여유 + 위험 없음 + 봇이 잡을 수 있음 (진짜 픽스 대상)
// "지상가능(안전·도달불가)"  — 지상 + 점프 여유 + 위험 없음 + 봇이 못 잡음 (스캐너 오분류)
// "지상가능(위험앞)"        — 지상 + 위험 우선 (오탐 가능성)
// "공중1점프(안전·도달가능)" — 공중 + 이단점프 여유 + 위험 없음 + 봇이 잡을 수 있음 (진짜)
// "공중1점프(안전·도달불가)" — 공중 + 이단점프 여유 + 위험 없음 + 봇이 못 잡음 (오분류)
// "공중1점프(위험앞)"        — 공중 + 위험 우선 (오탐 가능성)
// "점프없음"                — 점프 남은 것 0 (못 잡음)
// "기타"                    — 분류 못함
type Category =
  | "지상가능(안전·도달가능)"
  | "지상가능(안전·도달불가)"
  | "지상가능(위험앞)"
  | "공중1점프(안전·도달가능)"
  | "공중1점프(안전·도달불가)"
  | "공중1점프(위험앞)"
  | "점프없음"
  | "기타";

function classify(s: ApproachSnapshot): Category {
  if (s.jumpsLeft <= 0) return "점프없음";
  if (s.onGround) {
    if (s.hasImminentHazard) return "지상가능(위험앞)";
    return s.catchable ? "지상가능(안전·도달가능)" : "지상가능(안전·도달불가)";
  }
  if (!s.onGround) {
    if (s.hasImminentHazard) return "공중1점프(위험앞)";
    return s.catchable ? "공중1점프(안전·도달가능)" : "공중1점프(안전·도달불가)";
  }
  return "기타";
}

// 진짜 픽스 대상 = 도달가능 카테고리만 (봇 여유 + 물리 도달 가능한데 놓친 것)
const SUSPECT_CATEGORIES: Category[] = [
  "지상가능(안전·도달가능)",
  "공중1점프(안전·도달가능)",
];

interface MissEntry {
  tick: number;
  src: "정적" | "spawn";
  itemX: number;
  itemY: number;
  kind: string;
  missedPri: number; // 놓친 아이템 pri (v=20 → 20, magnet → 1500 등)
  trackId: string;
  approach: ApproachSnapshot | null;
  category: Category | "접근없음";
  // 우선순위 오판 태그 — 이 미스 시점 최근 100 tick 이내 봇이 잡은 아이템 중
  // pri < missedPri 있으면 true. 즉 봇이 낮은 pri 잡느라 높은 pri 놓친 것.
  priorityMisjudge: boolean;
  priorityMisjudgeDetail: string; // 잡은 아이템 정보
}

// 아이템 pri 계산 (bot.ts itemPriority와 일치)
function priOf(item: { value?: number; effect?: string }): number {
  if (item.effect === "magnet") return 1500;
  if (item.effect === "heal") return 1000;
  if (item.effect) return 100;
  return item.value ?? 1;
}

// 우선순위 오판 감지 — 미스 tick 최근 MISJUDGE_WINDOW 이내 봇이 잡은 아이템 중
// pri가 놓친 pri보다 낮은 것 있으면 hit. 즉 봇이 낮은 pri 잡느라 높은 pri 놓쳤을 가능성.
// 사용자 케이스 (v=5 잡느라 v=20 놓침) 감지 목적.
const MISJUDGE_WINDOW = 60; // 봇 이단점프 flight time(~40 tick) + 여유
// 진짜 오판: 놓친 아이템 지면(y≤baseHeight) + approach 시점 봇 이미 공중 위 궤도
// (봇 y > missedY + baseHeight, 즉 봇 몸통이 아이템 위) + 최근 봇 공중 catch 이력 존재
// + 잡은 pri < missedPri. 사용자 케이스 (v=20 지면 놓치고 v=5 공중 잡음) 딱 감지.
function detectPriorityMisjudge(
  history: { tick: number; pri: number; kind: string; x: number; y: number; botY: number }[],
  missTick: number,
  missedPri: number,
  missedY: number,
  approach: ApproachSnapshot | null,
  botBaseHeight: number,
): { hit: boolean; detail: string } {
  // 놓친 아이템 지면 (y=0 근처)
  if (missedY > botBaseHeight) return { hit: false, detail: "" };
  // approach 시점 봇 몸통이 아이템 완전 위 (도달불가 원인이 봇 궤도 상 위)
  if (!approach) return { hit: false, detail: "" };
  if (approach.onGround) return { hit: false, detail: "" };
  if (approach.botY <= missedY + botBaseHeight) return { hit: false, detail: "" };
  // 최근 봇 공중 catch 중 pri 작은 것 있는지
  const recent = history.filter(
    (h) => missTick - h.tick <= MISJUDGE_WINDOW && h.tick <= missTick,
  );
  const smaller = recent.filter((h) => h.pri < missedPri);
  if (smaller.length === 0) return { hit: false, detail: "" };
  smaller.sort((a, b) => a.pri - b.pri);
  const s = smaller[0]!;
  return {
    hit: true,
    detail: `공중잡음(t${s.tick} ${s.kind} pri=${s.pri} at ${s.x.toFixed(0)},${s.y})`,
  };
}

interface SeedResult {
  seed: number;
  ticks: number;
  collisions: number;
  alive: boolean;
  laps: number;
  coins: number;
  misses: MissEntry[];
  suspects: number; // 의심(지상가능/공중1점프) 미스 개수
}

// 스캐너 approach 캡처는 봇 catch 결정 시점에 하는 게 정확. 이전 80px 상수는
// 봇 아이템 훨씬 앞에서 캡처 → 다른 갈래(슬라이드 등) 태그로 오탐 다수.
// 실효 approach range = 봇 catch trigger MAX(70/300 초 × effSpeed). baseSpeed 300이면
// 70px, 신발×3이면 93px. 봇 speed 반영해 자동 조정. 여유 10px 추가.
const APPROACH_WINDOW_BASE = 70; // 기본 baseSpeed=300 기준
function approachWindowFor(runSpeed: number): number {
  return (APPROACH_WINDOW_BASE / 300) * runSpeed + 10;
}
// 이전 코드 호환용 상수 — scanSeed에서 봇 spec 반영해 재계산.
const APPROACH_WINDOW = 80;
// HAZARD 범위 — 봇 실제 회피 발동 zone + 여유. 봇 pit 회피는 60px, 지상 높은 장애물은 130px가
// max trigger. 이 값을 넘게 잡으면 진짜 봇 여유 있는데 놓친 미스가 오탐으로 필터돼 사라짐.
const HAZARD_PIT_RANGE = 100; // 봇 pit 발동 zone 60 + 여유 40
const HAZARD_OBSTACLE_RANGE = 150; // 봇 지상 높은 장애물 max trigger 130 + 여유 20

// 접근 시점에 봇 앞에 근접 위험(pit 또는 지상 장애물)이 있는지 감지.
// pitRange, obsRange 파라미터화 — sweep 검증용.
function detectImminentHazard(
  w: ReturnType<typeof createWorld>,
  pitRange: number = HAZARD_PIT_RANGE,
  obsRange: number = HAZARD_OBSTACLE_RANGE,
): { has: boolean; kind: string } {
  const bx = w.runner.x + w.runner.baseWidth; // 봇 몸통 오른쪽
  const cur = w.currentTrack;
  const offset = cur.length;
  for (const p of cur.pits ?? []) {
    if (p.x >= bx && p.x <= bx + pitRange) {
      return { has: true, kind: `pit@${p.x.toFixed(0)}` };
    }
  }
  for (const p of w.nextTrack.pits ?? []) {
    const absX = p.x + offset;
    if (absX >= bx && absX <= bx + pitRange) {
      return { has: true, kind: `pit@${absX.toFixed(0)}(next)` };
    }
  }
  for (let i = 0; i < cur.obstacles.length; i++) {
    if (w.destroyedObstacles[i]) continue;
    const o = cur.obstacles[i]!;
    if (o.kind === "platform") continue;
    if ((o.yBottom ?? 0) > 0) continue;
    if (o.x >= bx && o.x <= bx + obsRange) {
      return { has: true, kind: `obs@${o.x.toFixed(0)},h${o.height}` };
    }
  }
  for (const o of w.nextTrack.obstacles) {
    if (o.kind === "platform") continue;
    if ((o.yBottom ?? 0) > 0) continue;
    const absX = o.x + offset;
    if (absX >= bx && absX <= bx + obsRange) {
      return { has: true, kind: `obs@${absX.toFixed(0)},h${o.height}(next)` };
    }
  }
  return { has: false, kind: "" };
}

function scanSeed(
  seed: number,
  reach: number,
  pitRange: number = HAZARD_PIT_RANGE,
  obsRange: number = HAZARD_OBSTACLE_RANGE,
  kindFilter: string | null = KIND_FILTER,
  loadout: Loadout = LOADOUT,
): SeedResult {
  const w = createWorld(seed, trackPool, loadout);
  const misses: MissEntry[] = [];
  let collisions = 0;
  const seen = new Set<string>();
  // 각 watched item에 대해 봇이 trigger 가능 거리에 처음 도달한 시점 스냅샷.
  const approached = new Map<string, ApproachSnapshot>();
  const PASS_THRESHOLD = 30;
  const approachWin = approachWindowFor(
    (loadout.character as CharacterSpec).runSpeed,
  );
  let ticks = 0;
  // 봇이 실제 잡은 아이템 이력 — 미스 시점에 최근 잡은 것과 비교해 우선순위 오판 감지.
  // catchInFlight — 봇이 공중 상태에서 catch한 것만 저장 (지상 자연 수집은 제외).
  // 지상 walking으로 잡은 v=1 코인 등은 봇 판단과 무관 → 오판 감지 대상 아님.
  const catchHistory: { tick: number; pri: number; kind: string; x: number; y: number; botY: number }[] = [];
  // 잡음 delta 감지용 이전 상태
  let prevStaticCollected = new Set<number>();
  let prevSpawnCollected = new Map<number, boolean>(); // 인덱스별 collected 상태

  while (w.runner.alive && w.runner.lap < MAX_LAPS && ticks < MAX_TICKS) {
    const input = decide(w);
    step(w, input);
    ticks++;
    const r = w.runner;
    if (w.lastCollision) collisions++;

    // 잡음 delta 감지 (이 tick에 새로 잡힌 아이템) — 공중 catch만 저장.
    // 지상 자연 수집은 봇 판단 아니라 걸어가다 자연 수집. 오판 감지 대상 X.
    const isInFlightCatch = !r.onGround && r.y > r.baseHeight * 0.5; // 몸통 반 이상 지면 위
    for (let i = 0; i < w.currentTrack.items.length; i++) {
      if (w.currentItemCollected[i] && !prevStaticCollected.has(i)) {
        const it = w.currentTrack.items[i]!;
        if (isInFlightCatch) {
          catchHistory.push({
            tick: w.tick,
            pri: priOf(it),
            kind: kindOf(it),
            x: it.x,
            y: it.y,
            botY: r.y,
          });
        }
        prevStaticCollected.add(i);
      }
    }
    for (let j = 0; j < w.spawnedItems.length; j++) {
      const sp = w.spawnedItems[j]!;
      const wasCol = prevSpawnCollected.get(j) ?? false;
      if (sp.collected && !wasCol && isInFlightCatch) {
        catchHistory.push({
          tick: w.tick,
          pri: priOf(sp),
          kind: kindOf(sp),
          x: sp.x,
          y: sp.y,
          botY: r.y,
        });
      }
      prevSpawnCollected.set(j, sp.collected);
    }
    // 트랙 wrap 시 캐치 이력·상태 리셋
    if (r.lap !== 0 && w.currentItemCollected.length !== prevStaticCollected.size) {
      // wrap 감지: 새 트랙 진입 시 리셋
      if (r.x < 100) {
        prevStaticCollected.clear();
        prevSpawnCollected.clear();
      }
    }

    const dashActive = w.skills.some(
      (s) => s.activeTicks > 0 && s.spec.id === "dash",
    );
    const immune =
      r.invincibleTicks > 0 ||
      r.itemDashTicks > 0 ||
      r.giantTicks > 0 ||
      dashActive;
    const snapshot = (): ApproachSnapshot => {
      const hazard = detectImminentHazard(w, pitRange, obsRange);
      return {
        tick: w.tick,
        botX: r.x,
        botY: r.y,
        onGround: r.onGround,
        jumpsLeft: r.jumpsLeft,
        vy: Math.round(r.vy),
        immune,
        debugReason: input.debugReason ?? "",
        hasImminentHazard: hazard.has,
        hazardKind: hazard.kind,
        catchable: false, // 이후 window 안 tick 진행하며 갱신
      };
    };

    const trackKey = `t${r.lap}`;
    const spec = loadout.character as CharacterSpec;
    // 접근 + 미스 검사 (정적 아이템)
    for (let i = 0; i < w.currentTrack.items.length; i++) {
      if (w.currentItemCollected[i]) continue;
      const item = w.currentTrack.items[i]!;
      if (!isWatched(item)) continue;
      if (item.y > reach) continue;
      if (kindFilter && kindOf(item) !== kindFilter) continue;
      const key = `${trackKey}:s:${i}`;

      // 접근 window 안이면: 첫 진입 시 snapshot 저장, 이후 매 tick catchable 갱신
      // 봇 슬라이드 중은 catch 결정 실행 X — approach 캡처 skip. 슬라이드 종료 후 실제
      // catch 결정 시점 (walking 상태)의 debugReason이 정확한 원인 태그.
      const inWindow =
        r.x >= item.x - approachWin &&
        r.x <= item.x + PASS_THRESHOLD &&
        !r.sliding;
      if (inWindow) {
        let snap = approached.get(key);
        if (!snap) {
          snap = snapshot();
          approached.set(key, snap);
        }
        if (!snap.catchable && r.jumpsLeft > 0) {
          if (canCatchWithJumpNow(r.x, r.y, r.onGround, item.x, item.y, spec)) {
            snap.catchable = true;
          }
        }
      }

      // 통과한 미스
      if (r.x > item.x + PASS_THRESHOLD && !seen.has(key)) {
        seen.add(key);
        const approach = approached.get(key) ?? null;
        const missedPri = priOf(item);
        const misjudge = detectPriorityMisjudge(
          catchHistory,
          w.tick,
          missedPri,
          item.y,
          approach,
          r.baseHeight,
        );
        misses.push({
          tick: w.tick,
          src: "정적",
          itemX: Math.round(item.x * 10) / 10,
          itemY: item.y,
          kind: kindOf(item),
          missedPri,
          trackId: w.currentTrack.id,
          approach,
          category: approach ? classify(approach) : "접근없음",
          priorityMisjudge: misjudge.hit,
          priorityMisjudgeDetail: misjudge.detail,
        });
      }
    }
    // 동일 패턴 — spawn 아이템
    for (let j = 0; j < w.spawnedItems.length; j++) {
      const sp = w.spawnedItems[j]!;
      if (sp.collected) continue;
      if (!isWatched(sp)) continue;
      if (sp.y > reach) continue;
      if (kindFilter && kindOf(sp) !== kindFilter) continue;
      const key = `${trackKey}:d:${j}`;
      const inWindow =
        r.x >= sp.x - approachWin &&
        r.x <= sp.x + PASS_THRESHOLD &&
        !r.sliding;
      if (inWindow) {
        let snap = approached.get(key);
        if (!snap) {
          snap = snapshot();
          approached.set(key, snap);
        }
        if (!snap.catchable && r.jumpsLeft > 0) {
          if (canCatchWithJumpNow(r.x, r.y, r.onGround, sp.x, sp.y, spec)) {
            snap.catchable = true;
          }
        }
      }
      if (r.x > sp.x + PASS_THRESHOLD && !seen.has(key)) {
        seen.add(key);
        const approach = approached.get(key) ?? null;
        const missedPri = priOf(sp);
        const misjudge = detectPriorityMisjudge(
          catchHistory,
          w.tick,
          missedPri,
          sp.y,
          approach,
          r.baseHeight,
        );
        misses.push({
          tick: w.tick,
          src: "spawn",
          itemX: Math.round(sp.x * 10) / 10,
          itemY: sp.y,
          kind: kindOf(sp),
          missedPri,
          trackId: w.currentTrack.id,
          approach,
          category: approach ? classify(approach) : "접근없음",
          priorityMisjudge: misjudge.hit,
          priorityMisjudgeDetail: misjudge.detail,
        });
      }
    }
  }

  const suspects = misses.filter((m) =>
    SUSPECT_CATEGORIES.includes(m.category as Category),
  ).length;

  return {
    seed,
    ticks,
    collisions,
    alive: w.runner.alive,
    laps: w.runner.lap,
    coins: w.runner.coins,
    misses,
    suspects,
  };
}

describe("미스 스캐너", () => {
  const filterLabel = KIND_FILTER ? `[${KIND_FILTER} only]` : "[all watched]";
  it(`${SCAN_COUNT}개 시드 ${filterLabel} (start=${SCAN_START_SEED}) ${LOADOUT.character.id}+${LOADOUT.pet?.id ?? "(no pet)"}`, () => {
    const reach = singleJumpReach(LOADOUT.character as CharacterSpec);
    const rng = new Rng(SCAN_START_SEED);

    const results: SeedResult[] = [];
    const kindCounts = new Map<string, number>();
    const trackCounts = new Map<string, number>();
    const categoryCounts = new Map<string, number>();
    let totalMisses = 0;
    let totalSuspects = 0;

    for (let i = 0; i < SCAN_COUNT; i++) {
      const seed = rng.nextInt(0, 0x7fffffff);
      const res = scanSeed(seed, reach);
      results.push(res);
      totalMisses += res.misses.length;
      totalSuspects += res.suspects;
      for (const m of res.misses) {
        kindCounts.set(m.kind, (kindCounts.get(m.kind) ?? 0) + 1);
        trackCounts.set(m.trackId, (trackCounts.get(m.trackId) ?? 0) + 1);
        categoryCounts.set(m.category, (categoryCounts.get(m.category) ?? 0) + 1);
      }
    }

    // 의심 미스 많은 시드 우선 정렬 — 의심 없으면 전체 미스 수
    results.sort((a, b) => b.suspects - a.suspects || b.misses.length - a.misses.length);

    const lines: string[] = [];
    lines.push("");
    lines.push(
      `=== 스캔 — ${SCAN_COUNT}개 시드 ${filterLabel} (${LOADOUT.character.id}+${LOADOUT.pet?.id ?? "(no pet)"}) ===`,
    );
    lines.push(`총 미스 ${totalMisses}건  /  ?의심(지상가능+공중1점프) ${totalSuspects}건`);
    const colSeeds = results.filter((r) => r.collisions > 0).length;
    const deadSeeds = results.filter((r) => !r.alive).length;
    lines.push(`충돌 시드 ${colSeeds}  /  사망 시드 ${deadSeeds}`);

    lines.push("");
    lines.push("--- 분류별 ---");
    const sortedCats = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, c] of sortedCats) {
      const tag = SUSPECT_CATEGORIES.includes(k as Category) ? " ⚠️" : "";
      lines.push(`  ${k}: ${c}${tag}`);
    }

    if (!KIND_FILTER) {
      lines.push("");
      lines.push("--- 미스 종류별 ---");
      const sortedKinds = [...kindCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [k, c] of sortedKinds) lines.push(`  ${k}: ${c}`);
    }

    lines.push("");
    lines.push("--- 트랙별 ---");
    const sortedTracks = [...trackCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, c] of sortedTracks) lines.push(`  ${k}: ${c}`);

    lines.push("");
    lines.push(`--- 의심 미스 많은 시드 top ${TOP_K} ---`);
    for (const r of results.slice(0, TOP_K)) {
      lines.push(
        `seed=${r.seed} ?의심=${r.suspects} 미스=${r.misses.length} 코인=${r.coins} ticks=${r.ticks}${r.alive ? "" : " 💀"}`,
      );
      // 의심 미스 우선 노출
      const suspectMisses = r.misses.filter((m) =>
        SUSPECT_CATEGORIES.includes(m.category as Category),
      );
      const display = suspectMisses.length > 0 ? suspectMisses : r.misses;
      for (const m of display.slice(0, SAMPLES_PER_SEED)) {
        const a = m.approach;
        const ctx = a
          ? `ground=${a.onGround} jumps=${a.jumpsLeft} vy=${a.vy}${a.immune ? " IMMUNE" : ""}` +
            (a.hasImminentHazard ? ` HAZARD=${a.hazardKind}` : "") +
            (a.debugReason ? ` [why="${a.debugReason}"]` : "")
          : "(접근 윈도우 캡처 실패)";
        lines.push(
          `  [${m.category}] t${m.tick} ${m.src} ${m.trackId} ${m.kind} item=(${m.itemX},${m.itemY}) ${ctx}`,
        );
      }
      if (display.length > SAMPLES_PER_SEED) {
        lines.push(`  ... (+${display.length - SAMPLES_PER_SEED}건)`);
      }
    }

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });

  // ── 방법 A: HAZARD 필터 값 스윕 (반응 곡선) ─────────────────────────
  // 여러 pit/obs 범위 조합에서 안전 vs 위험앞 건수 표. 필터 값 상관없이 안전인 미스
  // = 확실한 진짜 픽스 대상. 값 바뀔 때 이동하는 미스 = 경계 케이스.
  it(`HAZARD 필터 값 스윕 (검증 A)`, () => {
    const reach = singleJumpReach(LOADOUT.character as CharacterSpec);
    const sweepPitVals = [50, 75, 100, 125, 150, 200, 300, 500];
    // 지상 장애물은 pit과 비례로 함께 스윕
    const obsMult = 1.5; // 봇 실제 발동 zone 비율 (pit 60 vs 장애물 max 130 → 대략 2배 근처, 1.5로 근사)

    const lines: string[] = [];
    lines.push("");
    lines.push(
      `=== HAZARD 필터 스윕 (${SCAN_COUNT} 시드, ${KIND_FILTER ?? "all watched"}) ===`,
    );
    lines.push(
      "pit범위 | obs범위 | G도달가능 | A도달가능 | G도달불가 | A도달불가 | G위험 | A위험",
    );
    lines.push("-".repeat(88));

    for (const pitR of sweepPitVals) {
      const obsR = Math.round(pitR * obsMult);
      const rng = new Rng(SCAN_START_SEED);
      let gCatchable = 0,
        aCatchable = 0,
        gUnreach = 0,
        aUnreach = 0,
        gHaz = 0,
        aHaz = 0;
      for (let i = 0; i < SCAN_COUNT; i++) {
        const seed = rng.nextInt(0, 0x7fffffff);
        const res = scanSeed(seed, reach, pitR, obsR);
        for (const m of res.misses) {
          if (m.category === "지상가능(안전·도달가능)") gCatchable++;
          else if (m.category === "공중1점프(안전·도달가능)") aCatchable++;
          else if (m.category === "지상가능(안전·도달불가)") gUnreach++;
          else if (m.category === "공중1점프(안전·도달불가)") aUnreach++;
          else if (m.category === "지상가능(위험앞)") gHaz++;
          else if (m.category === "공중1점프(위험앞)") aHaz++;
        }
      }
      lines.push(
        `  ${String(pitR).padStart(5)}  |  ${String(obsR).padStart(5)}  |   ${String(gCatchable).padStart(3)}   |   ${String(aCatchable).padStart(3)}   |   ${String(gUnreach).padStart(3)}    |   ${String(aUnreach).padStart(3)}    |   ${String(gHaz).padStart(3)}   |   ${String(aHaz).padStart(3)}`,
      );
    }

    lines.push("");
    lines.push(
      "해석: 안전 카테고리가 pit범위에 상관없이 일정한 값 = 확실 픽스 대상. 값 바뀔 때 이동 = 경계 케이스.",
    );
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });

  // ── 방법 G: 우선순위 오판 감지 (미탐 2 해결) ─────────────
  // 봇이 낮은 pri 아이템 잡느라 높은 pri 놓친 케이스 감지. 사용자 케이스 (v=5 잡느라 v=20 놓침).
  // 로드아웃별 우선순위 오판 카운트.
  it(`우선순위 오판 감지 (검증 G)`, () => {
    const lines: string[] = [];
    lines.push("");
    lines.push(
      `=== 검증 G: 우선순위 오판 스캔 (100 시드, KIND=null 전체) ===`,
    );
    lines.push(
      "로드아웃                       | 총미스 | 우선순위오판 | 도달가능 | 도달가능+오판",
    );
    lines.push("-".repeat(88));

    const misjudgeExamples = new Map<string, string[]>();

    for (const bl of ALL_LOADOUTS) {
      const reach = singleJumpReach(bl.loadout.character as CharacterSpec);
      const rng = new Rng(SCAN_START_SEED);
      let total = 0;
      let misjudge = 0;
      let catchable = 0;
      let catchableAndMisjudge = 0;
      const examples: string[] = [];
      for (let i = 0; i < SCAN_COUNT; i++) {
        const seed = rng.nextInt(0, 0x7fffffff);
        const res = scanSeed(seed, reach, HAZARD_PIT_RANGE, HAZARD_OBSTACLE_RANGE, null, bl.loadout);
        total += res.misses.length;
        for (const m of res.misses) {
          const isCatchable =
            m.category === "지상가능(안전·도달가능)" ||
            m.category === "공중1점프(안전·도달가능)";
          if (m.priorityMisjudge) misjudge++;
          if (isCatchable) catchable++;
          if (m.priorityMisjudge && isCatchable) catchableAndMisjudge++;
          if (m.priorityMisjudge && examples.length < 6) {
            examples.push(
              `${seed}(t${m.tick},${m.kind} pri=${m.missedPri} at ${m.itemX},${m.itemY}) ${m.priorityMisjudgeDetail}`,
            );
          }
        }
      }
      lines.push(
        `  ${bl.label.padEnd(30)}|  ${String(total).padStart(4)}  |    ${String(misjudge).padStart(4)}      |   ${String(catchable).padStart(3)}    |     ${String(catchableAndMisjudge).padStart(3)}`,
      );
      misjudgeExamples.set(bl.label, examples);
    }

    lines.push("");
    lines.push("--- 로드아웃별 우선순위 오판 대표 사례 ---");
    for (const [label, ex] of misjudgeExamples) {
      lines.push(`  [${label}]`);
      for (const e of ex) lines.push(`    ${e}`);
    }

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });

  // ── 방법 F: 로드아웃 다양화 스캔 (미탐 1 해결) ─────────────
  // 지금까지는 머루+누룽지 한 조합만 스캔. 다른 로드아웃 (황태 계열, 강화 장비 등)에서
  // 발생하는 봇 판단 오류를 놓침. 8개 로드아웃 각각 스캔해서 조합별 진짜 픽스 대상 카운트.
  it(`로드아웃 다양화 (검증 F)`, () => {
    const lines: string[] = [];
    lines.push("");
    lines.push(
      `=== 검증 F: 로드아웃별 스캔 (100 시드, KIND=null 전체, pit=${HAZARD_PIT_RANGE}) ===`,
    );
    lines.push(
      "로드아웃                       | 총미스 | G도달가능 | A도달가능 | 도달불가 | 위험앞 | 점프없음",
    );
    lines.push("-".repeat(102));

    const catchableByLoad = new Map<string, string[]>();

    for (const bl of ALL_LOADOUTS) {
      const reach = singleJumpReach(bl.loadout.character as CharacterSpec);
      const rng = new Rng(SCAN_START_SEED);
      const counts = new Map<string, number>();
      let total = 0;
      const catchable: string[] = [];
      for (let i = 0; i < SCAN_COUNT; i++) {
        const seed = rng.nextInt(0, 0x7fffffff);
        const res = scanSeed(seed, reach, HAZARD_PIT_RANGE, HAZARD_OBSTACLE_RANGE, null, bl.loadout);
        total += res.misses.length;
        for (const m of res.misses) {
          counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
          if (
            m.category === "지상가능(안전·도달가능)" ||
            m.category === "공중1점프(안전·도달가능)"
          ) {
            const why = m.approach?.debugReason ?? "?";
            catchable.push(
              `${seed}(t${m.tick},${m.kind},item=${m.itemX},${m.itemY},why="${why}")`,
            );
          }
        }
      }
      const gC = counts.get("지상가능(안전·도달가능)") ?? 0;
      const aC = counts.get("공중1점프(안전·도달가능)") ?? 0;
      const gU = counts.get("지상가능(안전·도달불가)") ?? 0;
      const aU = counts.get("공중1점프(안전·도달불가)") ?? 0;
      const gH = counts.get("지상가능(위험앞)") ?? 0;
      const aH = counts.get("공중1점프(위험앞)") ?? 0;
      const nj = counts.get("점프없음") ?? 0;
      lines.push(
        `  ${bl.label.padEnd(30)}|  ${String(total).padStart(4)}  |    ${String(gC).padStart(3)}    |    ${String(aC).padStart(3)}    |   ${String(gU + aU).padStart(4)}   |   ${String(gH + aH).padStart(3)}   |   ${String(nj).padStart(3)}`,
      );
      catchableByLoad.set(bl.label, catchable);
    }

    lines.push("");
    lines.push("--- 로드아웃별 진짜 픽스 대상 (도달가능) 대표 ---");
    for (const [label, seeds] of catchableByLoad) {
      lines.push(`  [${label}] ${seeds.length}건`);
      for (const s of seeds.slice(0, 4)) lines.push(`    ${s}`);
      if (seeds.length > 4) lines.push(`    ... (+${seeds.length - 4}건)`);
    }

    // 원인 태그 집계 (전체)
    const whyCount = new Map<string, number>();
    for (const seeds of catchableByLoad.values()) {
      for (const s of seeds) {
        const m = s.match(/why="([^"]*)"/);
        const why = m ? m[1]! : "?";
        whyCount.set(why, (whyCount.get(why) ?? 0) + 1);
      }
    }
    lines.push("");
    lines.push("--- 원인 태그 집계 (전체 로드아웃 합) ---");
    const sortedWhy = [...whyCount.entries()].sort((a, b) => b[1] - a[1]);
    for (const [why, c] of sortedWhy) lines.push(`  ${why}: ${c}건`);

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });

  // ── 방법 E: KIND 커버리지 확장 — 종류별 스캔 결과 ─────────────
  // heal 이외 모든 watched 종류 (magnet, dash, giant, coin v=5, v=20)에 대해 각각 스캔.
  // KIND별 진짜 픽스 대상 카운트로 전체 실질 오류 범위 확정.
  it(`KIND 커버리지 확장 (검증 E)`, () => {
    const reach = singleJumpReach(LOADOUT.character as CharacterSpec);
    const kinds: string[] = ["heal", "magnet", "dash", "giant", "coin v=5", "coin v=20"];

    const lines: string[] = [];
    lines.push("");
    lines.push(
      `=== 검증 E: KIND별 스캔 (100 시드 시작=42, pit=${HAZARD_PIT_RANGE}) ===`,
    );
    lines.push(
      "종류       | 총미스 | G도달가능 | A도달가능 | G도달불가 | A도달불가 | G위험 | A위험 | 점프없음 | 접근없음",
    );
    lines.push("-".repeat(110));

    const catchableByKind = new Map<string, string[]>();

    for (const kind of kinds) {
      const rng = new Rng(SCAN_START_SEED);
      const counts = new Map<string, number>();
      let total = 0;
      const catchable: string[] = [];
      for (let i = 0; i < SCAN_COUNT; i++) {
        const seed = rng.nextInt(0, 0x7fffffff);
        const res = scanSeed(seed, reach, HAZARD_PIT_RANGE, HAZARD_OBSTACLE_RANGE, kind);
        total += res.misses.length;
        for (const m of res.misses) {
          counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
          if (
            m.category === "지상가능(안전·도달가능)" ||
            m.category === "공중1점프(안전·도달가능)"
          ) {
            const why = m.approach?.debugReason ?? "?";
            catchable.push(`${seed}(t${m.tick},G=${m.approach?.onGround},item=${m.itemX},${m.itemY},why="${why}")`);
          }
        }
      }
      const gC = counts.get("지상가능(안전·도달가능)") ?? 0;
      const aC = counts.get("공중1점프(안전·도달가능)") ?? 0;
      const gU = counts.get("지상가능(안전·도달불가)") ?? 0;
      const aU = counts.get("공중1점프(안전·도달불가)") ?? 0;
      const gH = counts.get("지상가능(위험앞)") ?? 0;
      const aH = counts.get("공중1점프(위험앞)") ?? 0;
      const nj = counts.get("점프없음") ?? 0;
      const na = counts.get("접근없음") ?? 0;
      lines.push(
        `  ${kind.padEnd(10)}|   ${String(total).padStart(3)}  |    ${String(gC).padStart(3)}    |    ${String(aC).padStart(3)}    |    ${String(gU).padStart(3)}    |    ${String(aU).padStart(3)}    |  ${String(gH).padStart(3)}  |  ${String(aH).padStart(3)}  |   ${String(nj).padStart(3)}   |   ${String(na).padStart(3)}`,
      );
      catchableByKind.set(kind, catchable);
    }

    lines.push("");
    lines.push("--- 종류별 진짜 픽스 대상 (도달가능) ---");
    for (const [kind, seeds] of catchableByKind) {
      lines.push(`  [${kind}] ${seeds.length}건`);
      for (const s of seeds.slice(0, 8)) lines.push(`    ${s}`);
      if (seeds.length > 8) lines.push(`    ... (+${seeds.length - 8}건)`);
    }

    // 원인 태그 집계 (도달가능 카테고리 전체)
    const whyCount = new Map<string, number>();
    for (const seeds of catchableByKind.values()) {
      for (const s of seeds) {
        const m = s.match(/why="([^"]*)"/);
        const why = m ? m[1]! : "?";
        whyCount.set(why, (whyCount.get(why) ?? 0) + 1);
      }
    }
    lines.push("");
    lines.push("--- 원인 태그 집계 (전체 종류 합) ---");
    const sortedWhy = [...whyCount.entries()].sort((a, b) => b[1] - a[1]);
    for (const [why, c] of sortedWhy) lines.push(`  ${why}: ${c}건`);

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });

  // ── 방법 D: 다른 시드 시퀀스에서 스캐너 결과 재현성 확인 ─────────────
  // 지금까지 SCAN_START_SEED=42로 검증. 다른 시드 시퀀스에서도 카테고리 분포가
  // 일관되고 진짜 픽스 대상이 소수인지 확인 → 스캐너 신뢰도 재검증.
  it(`여러 시드 시퀀스 재현성 (검증 D)`, () => {
    const reach = singleJumpReach(LOADOUT.character as CharacterSpec);
    const startSeeds = [42, 100, 1000, 12345, 99999, 7777];

    const lines: string[] = [];
    lines.push("");
    lines.push(
      `=== 검증 D: 여러 시드 시퀀스 (각 100 시드, heal only, pit=${HAZARD_PIT_RANGE}) ===`,
    );
    lines.push(
      "시작시드 | 총미스 | G도달가능 | A도달가능 | G도달불가 | A도달불가 | G위험 | A위험 | 점프없음 | 접근없음",
    );
    lines.push("-".repeat(108));

    const catchableSeedsAll = new Map<string, string[]>(); // 진짜 픽스 대상 시드 리스트

    for (const start of startSeeds) {
      const rng = new Rng(start);
      const counts = new Map<string, number>();
      let total = 0;
      const catchableSeeds: string[] = [];
      for (let i = 0; i < SCAN_COUNT; i++) {
        const seed = rng.nextInt(0, 0x7fffffff);
        const res = scanSeed(seed, reach);
        total += res.misses.length;
        for (const m of res.misses) {
          counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
          if (
            m.category === "지상가능(안전·도달가능)" ||
            m.category === "공중1점프(안전·도달가능)"
          ) {
            const why = m.approach?.debugReason ?? "?";
            catchableSeeds.push(`${seed}(t${m.tick},why="${why}")`);
          }
        }
      }
      const gC = counts.get("지상가능(안전·도달가능)") ?? 0;
      const aC = counts.get("공중1점프(안전·도달가능)") ?? 0;
      const gU = counts.get("지상가능(안전·도달불가)") ?? 0;
      const aU = counts.get("공중1점프(안전·도달불가)") ?? 0;
      const gH = counts.get("지상가능(위험앞)") ?? 0;
      const aH = counts.get("공중1점프(위험앞)") ?? 0;
      const nj = counts.get("점프없음") ?? 0;
      const na = counts.get("접근없음") ?? 0;
      lines.push(
        `  ${String(start).padStart(6)} |   ${String(total).padStart(3)}  |    ${String(gC).padStart(3)}    |    ${String(aC).padStart(3)}    |    ${String(gU).padStart(3)}    |    ${String(aU).padStart(3)}    |  ${String(gH).padStart(3)}  |  ${String(aH).padStart(3)}  |   ${String(nj).padStart(3)}   |   ${String(na).padStart(3)}`,
      );
      catchableSeedsAll.set(String(start), catchableSeeds);
    }

    lines.push("");
    lines.push("--- 진짜 픽스 대상 시드 (도달가능 카테고리) ---");
    for (const [start, seeds] of catchableSeedsAll) {
      lines.push(`  시퀀스 ${start}: ${seeds.length}건`);
      for (const s of seeds) lines.push(`    ${s}`);
    }

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });

  // ── 방법 C: 실제 봇 시뮬로 강제 점프 override 후 아이템 잡히는지 검증 ─────
  // 물리 공식(canCatchWithJumpNow)의 결과가 실제 봇 물리(gravity·dt·dash 등)와 일치하는지
  // 확인. 진짜 픽스 대상 후보 시드에 봇 시뮬 재현 → approach window 안 매 tick에 봇이
  // 강제로 점프 시도 → heal 잡히는지 실제 world.step으로 판정.
  it(`실제 봇 시뮬 - 강제 점프 override 검증 (검증 C)`, () => {
    interface VerifyCase {
      seed: number;
      approachTick: number;
      itemX: number;
      itemY: number;
      note: string;
    }
    // 진짜 픽스 대상 후보 (지상가능·도달가능으로 분류된 것)
    const cases: VerifyCase[] = [
      { seed: 1737363627, approachTick: 167, itemX: 803.7, itemY: 150, note: "지상가능(도달가능) 검증" },
      { seed: 238248633, approachTick: 602, itemX: 2976, itemY: 0, note: "why=지면 아이템 보호" },
    ];

    const lines: string[] = [];
    lines.push("");
    lines.push(`=== 검증 C: 강제 점프 override 실제 시뮬 ===`);

    for (const c of cases) {
      // 시뮬 1: 정상 봇 진행 (baseline) — 아이템 잡히는지
      const wBaseline = createWorld(c.seed, trackPool, LOADOUT);
      let baselineCaught = false;
      let baselineTicks = 0;
      while (wBaseline.runner.alive && baselineTicks < MAX_TICKS) {
        step(wBaseline, decide(wBaseline));
        baselineTicks++;
        // spawn 아이템 중 대상 (x, y) 찾아서 collected 확인
        for (const sp of wBaseline.spawnedItems) {
          if (
            !sp.collected &&
            Math.abs(sp.x - c.itemX) < 1 &&
            Math.abs(sp.y - c.itemY) < 1
          )
            continue;
          if (
            sp.collected &&
            Math.abs(sp.x - c.itemX) < 1 &&
            Math.abs(sp.y - c.itemY) < 1
          ) {
            baselineCaught = true;
          }
        }
        if (wBaseline.runner.x > c.itemX + 100) break;
      }

      // 시뮬 2: approach window 안 각 tick에서 강제 점프 시도 — 하나라도 잡으면 진짜 픽스 대상
      let anyCaught = false;
      let caughtAtTick = -1;
      // approach window 시작 tick 찾기 (봇이 처음 approach window 진입)
      const wProbeApproach = createWorld(c.seed, trackPool, LOADOUT);
      let approachStartTick = -1;
      while (wProbeApproach.runner.alive) {
        step(wProbeApproach, decide(wProbeApproach));
        if (
          wProbeApproach.runner.x >= c.itemX - APPROACH_WINDOW &&
          wProbeApproach.runner.x <= c.itemX + 30
        ) {
          approachStartTick = wProbeApproach.tick;
          break;
        }
        if (wProbeApproach.runner.x > c.itemX + 30) break;
      }
      if (approachStartTick < 0) {
        lines.push(`  [seed=${c.seed}] approach 재현 실패`);
        continue;
      }
      // 각 override tick 시도 (approach 시점 ~ 20 tick 이후)
      for (let overrideTick = approachStartTick; overrideTick <= approachStartTick + 20; overrideTick++) {
        const w = createWorld(c.seed, trackPool, LOADOUT);
        let ticks = 0;
        let caught = false;
        let jumped = false;
        while (w.runner.alive && ticks < MAX_TICKS) {
          let input = decide(w);
          if (w.tick === overrideTick && !jumped && w.runner.jumpsLeft > 0) {
            input = { ...input, jump: true };
            jumped = true;
          }
          step(w, input);
          ticks++;
          for (const sp of w.spawnedItems) {
            if (
              sp.collected &&
              Math.abs(sp.x - c.itemX) < 1 &&
              Math.abs(sp.y - c.itemY) < 1
            ) {
              caught = true;
            }
          }
          if (w.runner.x > c.itemX + 200 || caught) break;
        }
        if (caught) {
          anyCaught = true;
          caughtAtTick = overrideTick;
          break;
        }
      }

      const verdict = anyCaught
        ? `✓ override t${caughtAtTick}에서 잡음 → 진짜 픽스 대상`
        : "✗ 아무 override에도 못 잡음 → 오분류";
      lines.push(
        `  [seed=${c.seed} ${c.note}] approach시작t=${approachStartTick} baseline=${baselineCaught ? "잡음" : "놓침"} ${verdict}`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });

  // ── 방법 B: 새로 "안전"으로 분류된 케이스 물리 시뮬 검증 ─────────────
  // pit 300 필터에선 위험앞이었다가 pit 100 필터에선 안전이 된 3건 각각:
  // 봇이 그 접근 시점에 점프/이단점프 발동했다면 진짜 아이템 잡을 수 있었는지 물리 공식으로 확인.
  it(`새 안전 분류 3건 물리 시뮬 검증 (검증 B)`, () => {
    // 검증 대상 (approach 시점의 봇 상태를 재현해서 확인)
    interface VerifyCase {
      seed: number;
      approachTick: number;
      itemX: number;
      itemY: number;
      note: string;
    }
    const cases: VerifyCase[] = [
      { seed: 58247507, approachTick: 509, itemX: 2658.7, itemY: 0, note: "공중1점프(안전)" },
      { seed: 1737363627, approachTick: 167, itemX: 803.7, itemY: 150, note: "지상가능(안전)" },
      { seed: 1438242901, approachTick: 317, itemX: 1551.3, itemY: 80, note: "지상가능(안전)" },
    ];

    const G = -2200; // world.ts GRAVITY
    const character = LOADOUT.character as CharacterSpec;
    const baseSpeed = character.runSpeed;
    const jV = character.jumpVelocity;
    const baseH = character.height;

    // 봇 (x0, y0, vy0, jL, onGround) 상태에서 jump 발동 시 x_target 도달 시점 y 계산.
    // return: 아이템 잡는지 여부 (봇 몸통 [y, y+baseH]에 itemY 포함)
    function canCatchWithJump(
      x0: number,
      y0: number,
      vy0: number,
      onGround: boolean,
      itemX: number,
      itemY: number,
    ): { catches: boolean; botYAtItem: number; timeToItem: number } {
      const timeToItem = (itemX - x0) / baseSpeed;
      if (timeToItem < 0) {
        return { catches: false, botYAtItem: 0, timeToItem };
      }
      // 지금 점프 발동
      const newVy = onGround ? jV : jV; // 지상은 새 점프, 공중은 이단점프 (vy를 jV로 초기화)
      // 궤도: y(t) = y0 + vy*t + G*t^2/2
      const y = y0 + newVy * timeToItem + (G / 2) * timeToItem * timeToItem;
      const catches = itemY >= y && itemY <= y + baseH;
      return { catches, botYAtItem: y, timeToItem };
    }

    const lines: string[] = [];
    lines.push("");
    lines.push(`=== 새 안전 분류 3건 물리 시뮬 검증 ===`);

    for (const c of cases) {
      // 시드 재현 — 봇이 item.x - APPROACH_WINDOW ~ item.x + PASS_THRESHOLD 범위에
      // 처음 진입한 시점 상태를 캡처 (스캐너 approach 캡처 로직과 동일하게).
      const w = createWorld(c.seed, trackPool, LOADOUT);
      let botAtApproach: {
        x: number;
        y: number;
        vy: number;
        jL: number;
        onGround: boolean;
        tick: number;
      } | null = null;
      let ticks = 0;
      while (w.runner.alive && ticks < MAX_TICKS) {
        step(w, decide(w));
        ticks++;
        const r = w.runner;
        if (
          botAtApproach === null &&
          r.x >= c.itemX - 80 &&
          r.x <= c.itemX + 30
        ) {
          botAtApproach = {
            x: r.x,
            y: r.y,
            vy: r.vy,
            jL: r.jumpsLeft,
            onGround: r.onGround,
            tick: w.tick,
          };
          break;
        }
        // 봇이 이미 item 지난 경우
        if (r.x > c.itemX + 30 && botAtApproach === null) {
          break;
        }
      }
      if (!botAtApproach) {
        lines.push(`  [seed=${c.seed}] 재현 실패`);
        continue;
      }
      const r = canCatchWithJump(
        botAtApproach.x,
        botAtApproach.y,
        botAtApproach.vy,
        botAtApproach.onGround,
        c.itemX,
        c.itemY,
      );
      const verdict = r.catches ? "✓ 진짜 픽스 대상" : "✗ 잡을 수 없음 (오분류)";
      lines.push(
        `  [seed=${c.seed} 스캐너t=${c.approachTick} verify캡처t=${botAtApproach.tick} ${c.note}] 봇(x=${botAtApproach.x.toFixed(0)},y=${botAtApproach.y.toFixed(0)},vy=${botAtApproach.vy.toFixed(0)},jL=${botAtApproach.jL},G=${botAtApproach.onGround}) → item(${c.itemX},${c.itemY})`,
      );
      lines.push(
        `    점프 시 봇 y at item.x = ${r.botYAtItem.toFixed(1)} (몸통 [${r.botYAtItem.toFixed(1)}~${(r.botYAtItem + baseH).toFixed(1)}]) ${verdict}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });
});
