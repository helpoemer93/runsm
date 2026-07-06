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

import defaultChar from "../src/data/characters/default.json";
import coinWalkerChar from "../src/data/characters/coin-walker.json";
import destroyerPet from "../src/data/pets/destroyer.json";
import fireworkPet from "../src/data/pets/firework.json";
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
  onGround: boolean;
  jumpsLeft: number;
  vy: number;
  immune: boolean; // dash·itemDash·giant·invincibleTicks 모두 포함
}

// 미스 시점 봇 상태와 휴리스틱 분류 — 수집 점프는 면역 무관(디자인)이라 면역은 분류 기준 X.
// "지상가능"  — ground + jumpsLeft ≥ 1 (점프해야 했음 — 가장 의심)
// "공중1점프" — !ground + jumpsLeft ≥ 1 (이단점프 보충 가능했음 — 의심)
// "점프없음" — jumpsLeft = 0 (못 잡음, 단점프/이단점프 이미 다 씀)
// "기타"     — 분류 못함 (거의 없을 것)
type Category = "지상가능" | "공중1점프" | "점프없음" | "기타";

function classify(s: ApproachSnapshot): Category {
  if (s.jumpsLeft <= 0) return "점프없음";
  if (s.onGround) return "지상가능";
  if (!s.onGround) return "공중1점프";
  return "기타";
}

const SUSPECT_CATEGORIES: Category[] = ["지상가능", "공중1점프"];

interface MissEntry {
  tick: number;
  src: "정적" | "spawn";
  itemX: number;
  itemY: number;
  kind: string;
  trackId: string;
  approach: ApproachSnapshot | null;
  category: Category | "접근없음";
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

const APPROACH_WINDOW = 80; // 봇이 item.x보다 이만큼 앞에 있을 때 trigger 검사 가능 (대략 JUMP_TRIGGER_MAX 부근)

function scanSeed(seed: number, reach: number): SeedResult {
  const w = createWorld(seed, trackPool, LOADOUT);
  const misses: MissEntry[] = [];
  let collisions = 0;
  const seen = new Set<string>();
  // 각 watched item에 대해 봇이 trigger 가능 거리에 처음 도달한 시점 스냅샷.
  const approached = new Map<string, ApproachSnapshot>();
  const PASS_THRESHOLD = 30;
  let ticks = 0;

  while (w.runner.alive && w.runner.lap < MAX_LAPS && ticks < MAX_TICKS) {
    step(w, decide(w));
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
    const snapshot = (): ApproachSnapshot => ({
      tick: w.tick,
      onGround: r.onGround,
      jumpsLeft: r.jumpsLeft,
      vy: Math.round(r.vy),
      immune,
    });

    const trackKey = `t${r.lap}`;
    // 접근 + 미스 검사 (정적 아이템)
    for (let i = 0; i < w.currentTrack.items.length; i++) {
      if (w.currentItemCollected[i]) continue;
      const item = w.currentTrack.items[i]!;
      if (!isWatched(item)) continue;
      if (item.y > reach) continue;
      if (KIND_FILTER && kindOf(item) !== KIND_FILTER) continue;
      const key = `${trackKey}:s:${i}`;

      // 접근 시점 캡처 — 봇이 item.x 앞 trigger 윈도우 안에 도달한 첫 tick
      if (
        !approached.has(key) &&
        r.x >= item.x - APPROACH_WINDOW &&
        r.x <= item.x + PASS_THRESHOLD
      ) {
        approached.set(key, snapshot());
      }

      // 통과한 미스
      if (r.x > item.x + PASS_THRESHOLD && !seen.has(key)) {
        seen.add(key);
        const approach = approached.get(key) ?? null;
        misses.push({
          tick: w.tick,
          src: "정적",
          itemX: Math.round(item.x * 10) / 10,
          itemY: item.y,
          kind: kindOf(item),
          trackId: w.currentTrack.id,
          approach,
          category: approach ? classify(approach) : "접근없음",
        });
      }
    }
    // 동일 패턴 — spawn 아이템
    for (let j = 0; j < w.spawnedItems.length; j++) {
      const sp = w.spawnedItems[j]!;
      if (sp.collected) continue;
      if (!isWatched(sp)) continue;
      if (sp.y > reach) continue;
      if (KIND_FILTER && kindOf(sp) !== KIND_FILTER) continue;
      const key = `${trackKey}:d:${j}`;
      if (
        !approached.has(key) &&
        r.x >= sp.x - APPROACH_WINDOW &&
        r.x <= sp.x + PASS_THRESHOLD
      ) {
        approached.set(key, snapshot());
      }
      if (r.x > sp.x + PASS_THRESHOLD && !seen.has(key)) {
        seen.add(key);
        const approach = approached.get(key) ?? null;
        misses.push({
          tick: w.tick,
          src: "spawn",
          itemX: Math.round(sp.x * 10) / 10,
          itemY: sp.y,
          kind: kindOf(sp),
          trackId: w.currentTrack.id,
          approach,
          category: approach ? classify(approach) : "접근없음",
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
          ? `ground=${a.onGround} jumps=${a.jumpsLeft} vy=${a.vy}${a.immune ? " IMMUNE" : ""}`
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
});
