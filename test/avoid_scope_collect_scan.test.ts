// 회피 궤적 안 놓친 수집 스캐너 — 봇이 회피 판단(회피점프/구멍 회피/이단점프 회피 등)으로
// 지나간 궤적 근처에 고가치 아이템(heal/dash/giant/magnet/큰코인)이 있었는데
// 살짝 궤적만 달랐으면 잡을 수 있었을 사례를 골라냄.
//
// miss_scan.test.ts 는 "왜 점프 안 했나" 관점이라면, 이 스캐너는 "왜 잡을 수 있는 데도
// 회피만 하고 지나갔나" 관점. 결과는 봇 회피 로직 개선 아이디어 발굴용.
//
// 회귀 아님 — 항상 통과. `npx vitest run test/avoid_scope_collect_scan.test.ts` 로 개별 실행.

import { describe, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";
import { Rng } from "../src/sim/rng";

import hwangtaeChar from "../src/data/characters/hwangtae.json";
import meruChar from "../src/data/characters/meru.json";
import nurungjiPet from "../src/data/pets/nurungji.json";
import geumbungeoPet from "../src/data/pets/geumbungeo.json";

import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

const SCAN_START_SEED = 42;
const SCAN_COUNT = 200;
const MAX_LAPS = 1;
const MAX_TICKS = 30000;
const TOP_K = 8;
const SAMPLES_PER_SEED = 4;

// 봇이 아이템을 스칠 만한 x 근처 tick 을 기록하는 창.
// 봇 좌측(item.x - PRE_WINDOW)에 있을 때부터 우측(item.x + POST_WINDOW) 사이의 궤적.
const PRE_WINDOW = 80;
const POST_WINDOW = 30;
// 궤적 최소 근접 거리 — 봇 몸통 중심과 아이템 사이 y 절대 거리 (px).
// 이 값 이하면 "궤적을 아주 살짝 어긋나 놓쳤다"고 판단.
const NEAR_MISS_Y = 45;
// 궤적 안 x 근접이 있어야 함. 봇 몸통 사각형 안 아이템 x가 들어온 tick이 없어야
// 진짜 "놓친" 것 (수집 성공한 아이템은 제외).

// 회피 계열 debugReason — 이 태그가 궤적 창 안에 있으면 "회피 궤적"으로 간주.
const AVOID_TAGS = new Set([
  "회피점프",
  "구멍 회피 지면",
  "구멍 회피 비행중",
  "이단점프 높은장애물",
  "정점 안전 높은장애물",
  "이단점프 이른발동 구멍",
  "앞 장애물 차단",
  "비행중 장애물 차단",
]);

interface Loadouts {
  label: string;
  loadout: Loadout;
}

const LOADOUTS: Loadouts[] = [
  {
    label: "hwangtae+nurungji",
    loadout: {
      character: hwangtaeChar as CharacterSpec,
      pet: nurungjiPet as PetSpec,
      equipment: [],
    },
  },
  {
    label: "meru+geumbungeo",
    loadout: {
      character: meruChar as CharacterSpec,
      pet: geumbungeoPet as PetSpec,
      equipment: [],
    },
  },
];

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

// watched: effect 아이템 전부 + 코인 v ≥ 5. (miss_scan과 동일 기준)
function isWatched(item: { value?: number; effect?: string }): boolean {
  if (item.effect) return true;
  return (item.value ?? 1) >= 5;
}

function kindOf(item: { value?: number; effect?: string }): string {
  return item.effect ?? `coin v=${item.value ?? 1}`;
}

interface TrajSample {
  tick: number;
  rx: number;
  ry: number;
  rwidth: number;
  rheight: number;
  vy: number;
  onGround: boolean;
  jumpsLeft: number;
  reason: string;
  immune: boolean;
}

interface AvoidMissEntry {
  tick: number; // 통과한 tick
  itemX: number;
  itemY: number;
  kind: string;
  src: "정적" | "spawn";
  trackId: string;
  minGap: number; // 봇 사각형이 아이템 x를 덮은 tick 중 y 겹침 최소 격차 (0=수집조건 만족)
  gapDir: "봇↑" | "봇↓" | "겹침"; // 봇이 아이템 위/아래/겹침
  avoidTags: string[]; // 창 안 등장한 회피 태그
  atMinGap: TrajSample | null; // 최소 격차 시점 봇 상태
}

interface SeedResult {
  seed: number;
  ticks: number;
  alive: boolean;
  collisions: number;
  coins: number;
  hits: AvoidMissEntry[];
}

function scanSeed(seed: number, loadout: Loadout): SeedResult {
  const w = createWorld(seed, trackPool, loadout);
  const hits: AvoidMissEntry[] = [];
  let collisions = 0;
  let ticks = 0;

  // 각 watched 아이템(트랙별 index)에 대한 궤적 창 기록.
  // key: `${lap}:${src}:${idx}` — spawn의 경우 j는 이번 트랙 lap의 index (spawnedItems는 전역).
  // spawn 재활용 최소화를 위해 spawned item 자체를 key로 씀 (참조 동일).
  const staticWindow = new Map<string, TrajSample[]>();
  const spawnWindow = new Map<object, TrajSample[]>(); // key = sp 참조
  const passedStatic = new Set<string>();
  const passedSpawn = new Set<object>();

  while (w.runner.alive && w.runner.lap < MAX_LAPS && ticks < MAX_TICKS) {
    const input = decide(w);
    step(w, input);
    ticks++;
    const r = w.runner;
    if (w.lastCollision) collisions++;

    const dashActive = w.skills.some(
      (s) => s.activeTicks > 0 && s.spec.id === "dash",
    );
    const immune =
      r.invincibleTicks > 0 ||
      r.itemDashTicks > 0 ||
      r.giantTicks > 0 ||
      dashActive;
    const sample: TrajSample = {
      tick: w.tick,
      rx: r.x,
      ry: r.y,
      rwidth: r.width,
      rheight: r.height,
      vy: Math.round(r.vy),
      onGround: r.onGround,
      jumpsLeft: r.jumpsLeft,
      reason: input.debugReason ?? "",
      immune,
    };

    const trackKey = `t${r.lap}`;

    // 정적 아이템 궤적 기록
    for (let i = 0; i < w.currentTrack.items.length; i++) {
      if (w.currentItemCollected[i]) continue;
      const item = w.currentTrack.items[i]!;
      if (!isWatched(item)) continue;
      const key = `${trackKey}:s:${i}`;
      if (passedStatic.has(key)) continue;
      if (r.x >= item.x - PRE_WINDOW && r.x <= item.x + POST_WINDOW) {
        const arr = staticWindow.get(key) ?? [];
        arr.push(sample);
        staticWindow.set(key, arr);
      }
      // 통과 판정 — 봇 사각형이 아이템 x를 완전히 지났고 여전히 미수집.
      if (r.x > item.x + POST_WINDOW) {
        passedStatic.add(key);
        const arr = staticWindow.get(key) ?? [];
        if (arr.length > 0) {
          const analyzed = analyzeWindow(arr, item.x, item.y);
          if (analyzed) {
            hits.push({
              tick: w.tick,
              itemX: Math.round(item.x * 10) / 10,
              itemY: item.y,
              kind: kindOf(item),
              src: "정적",
              trackId: w.currentTrack.id,
              minGap: analyzed.minGap,
              gapDir: analyzed.gapDir,
              avoidTags: analyzed.avoidTags,
              atMinGap: analyzed.atMin,
            });
          }
        }
        staticWindow.delete(key);
      }
    }

    // spawn 아이템 궤적 기록
    for (let j = 0; j < w.spawnedItems.length; j++) {
      const sp = w.spawnedItems[j]!;
      if (sp.collected) continue;
      if (!isWatched(sp)) continue;
      if (passedSpawn.has(sp)) continue;
      if (r.x >= sp.x - PRE_WINDOW && r.x <= sp.x + POST_WINDOW) {
        const arr = spawnWindow.get(sp) ?? [];
        arr.push(sample);
        spawnWindow.set(sp, arr);
      }
      if (r.x > sp.x + POST_WINDOW) {
        passedSpawn.add(sp);
        const arr = spawnWindow.get(sp) ?? [];
        if (arr.length > 0) {
          const analyzed = analyzeWindow(arr, sp.x, sp.y);
          if (analyzed) {
            hits.push({
              tick: w.tick,
              itemX: Math.round(sp.x * 10) / 10,
              itemY: sp.y,
              kind: kindOf(sp),
              src: "spawn",
              trackId: w.currentTrack.id,
              minGap: analyzed.minGap,
              gapDir: analyzed.gapDir,
              avoidTags: analyzed.avoidTags,
              atMinGap: analyzed.atMin,
            });
          }
        }
        spawnWindow.delete(sp);
      }
    }
  }

  return {
    seed,
    ticks,
    alive: w.runner.alive,
    collisions,
    coins: w.runner.coins,
    hits,
  };
}

function analyzeWindow(
  samples: TrajSample[],
  itemX: number,
  itemY: number,
): {
  minGap: number;
  gapDir: "봇↑" | "봇↓" | "겹침";
  avoidTags: string[];
  atMin: TrajSample;
} | null {
  let minGap = Number.POSITIVE_INFINITY;
  let atMin: TrajSample | null = null;
  let dirAtMin: "봇↑" | "봇↓" | "겹침" = "겹침";
  const tags = new Set<string>();
  let anyImmune = false;
  for (const s of samples) {
    if (s.immune) anyImmune = true;
    if (AVOID_TAGS.has(s.reason)) tags.add(s.reason);
    // 봇 몸통 사각형이 아이템 x를 실제로 덮은 tick만 후보
    if (itemX < s.rx || itemX > s.rx + s.rwidth) continue;
    // y 겹침 격차: 봇 사각형[r.y, r.y+r.height]와 아이템 점 y 사이 거리
    let gap = 0;
    let dir: "봇↑" | "봇↓" | "겹침" = "겹침";
    if (itemY < s.ry) {
      gap = s.ry - itemY;
      dir = "봇↑"; // 봇이 아이템 위 — 봇이 너무 높이 뛰어서 놓침
    } else if (itemY > s.ry + s.rheight) {
      gap = itemY - (s.ry + s.rheight);
      dir = "봇↓"; // 봇이 아이템 아래 — 봇이 안 뛰거나 덜 뛰어서 놓침
    }
    if (gap < minGap) {
      minGap = gap;
      atMin = s;
      dirAtMin = dir;
    }
  }
  if (tags.size === 0) return null;
  if (!atMin) return null; // 봇 x가 아이템 x 근처를 아예 못 덮음
  if (minGap > NEAR_MISS_Y) return null;
  if (minGap === 0) return null; // 실제 수집 조건 만족 tick 있으면 잡힌 것 (여기 안 옴)
  if (anyImmune) return null;
  return { minGap, gapDir: dirAtMin, avoidTags: Array.from(tags), atMin };
}

describe("회피 궤적 안 놓친 수집 스캐너", () => {
  for (const { label, loadout } of LOADOUTS) {
    it(`${SCAN_COUNT}개 시드 — ${label}`, () => {
      const rng = new Rng(SCAN_START_SEED);
      const results: SeedResult[] = [];
      const kindCount = new Map<string, number>();
      const tagCount = new Map<string, number>();
      const dirCount = new Map<string, number>();
      let totalHits = 0;

      for (let i = 0; i < SCAN_COUNT; i++) {
        const seed = rng.nextInt(0, 0x7fffffff);
        const res = scanSeed(seed, loadout);
        results.push(res);
        totalHits += res.hits.length;
        for (const h of res.hits) {
          kindCount.set(h.kind, (kindCount.get(h.kind) ?? 0) + 1);
          dirCount.set(h.gapDir, (dirCount.get(h.gapDir) ?? 0) + 1);
          for (const t of h.avoidTags) {
            tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
          }
        }
      }

      results.sort((a, b) => b.hits.length - a.hits.length);

      const lines: string[] = [];
      lines.push("");
      lines.push(`=== 회피 궤적 안 놓친 수집 — ${label} (${SCAN_COUNT}시드) ===`);
      lines.push(
        `총 후보 ${totalHits}건 / 후보 있는 시드 ${results.filter((r) => r.hits.length > 0).length}`,
      );

      if (totalHits > 0) {
        lines.push("");
        lines.push("--- 놓친 아이템 종류 ---");
        for (const [k, c] of [...kindCount.entries()].sort((a, b) => b[1] - a[1])) {
          lines.push(`  ${k}: ${c}`);
        }
        lines.push("");
        lines.push("--- 격차 방향 (봇↑ = 봇이 아이템 위 = 너무 뛰었음, 봇↓ = 봇이 아이템 아래 = 덜 뛰었음) ---");
        for (const [k, c] of [...dirCount.entries()].sort((a, b) => b[1] - a[1])) {
          lines.push(`  ${k}: ${c}`);
        }
        lines.push("");
        lines.push("--- 회피 태그 분포 ---");
        for (const [k, c] of [...tagCount.entries()].sort((a, b) => b[1] - a[1])) {
          lines.push(`  ${k}: ${c}`);
        }
        lines.push("");
        lines.push(`--- 후보 많은 시드 top ${TOP_K} ---`);
        for (const r of results.slice(0, TOP_K)) {
          if (r.hits.length === 0) break;
          lines.push(
            `seed=${r.seed} 후보=${r.hits.length} 코인=${r.coins} ticks=${r.ticks}${r.alive ? "" : " 💀"}`,
          );
          for (const h of r.hits.slice(0, SAMPLES_PER_SEED)) {
            const s = h.atMinGap!;
            lines.push(
              `  t${h.tick} ${h.src} ${h.trackId} ${h.kind} item=(${h.itemX},${h.itemY}) ${h.gapDir}격차=${h.minGap.toFixed(1)} atTick=${s.tick} bot=(x${s.rx.toFixed(0)},y${s.ry.toFixed(0)},h${s.rheight},vy${s.vy},gr${s.onGround ? 1 : 0},j${s.jumpsLeft}) atReason=[${s.reason}]`,
            );
          }
          if (r.hits.length > SAMPLES_PER_SEED) {
            lines.push(`  ... (+${r.hits.length - SAMPLES_PER_SEED}건)`);
          }
        }
      } else {
        lines.push("(후보 없음 — 회피 궤적 근처 놓친 고가치 아이템 못 찾음)");
      }

      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
    });
  }
});

void ([] as unknown as EquipmentSpec[]);
