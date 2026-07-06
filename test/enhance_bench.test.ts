// 강화 레벨별 헤드리스 벤치마크 — 같은 장비 × 다른 lv 빌드들을 비교해서
// 강화 시스템이 효율 곡선에 어떤 영향을 주는지 정량 측정.
//
// 측정 방식은 `test/bench.test.ts`와 동일 (다중 사이클, 사망 패널티 5초, 코인/분 핵심 지표).
// 일회성 측정 도구. 실행: `npx vitest run test/enhance_bench.test.ts`
// 회귀에서 제외: `--exclude test/enhance_bench.test.ts`

import { describe, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";
import { Rng } from "../src/sim/rng";

import defaultChar from "../src/data/characters/hwangtae.json";
import destroyerPet from "../src/data/pets/nurungji.json";
import shoesSpec from "../src/data/equipment/shoes.json";
import healTalismanSpec from "../src/data/equipment/heal-talisman.json";
import coinRingSpec from "../src/data/equipment/coin-ring.json";

import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

// ── 입력 ───────────────────────────────────────────────
const SEED_START = 42;
const SEED_COUNT = 50;
const DURATION_SECONDS = 300;
const DEATH_PENALTY_SECONDS = 5;

// 비교할 강화 레벨 (모두 같은 빌드, 슬롯 3칸 모두 동일 lv)
const LV_TIERS = [0, 10, 20, 30, 40, 50];
// ───────────────────────────────────────────────────────

const defaultC = defaultChar as CharacterSpec;
const destroyer = destroyerPet as PetSpec;
const shoes = shoesSpec as EquipmentSpec;
const healTalisman = healTalismanSpec as EquipmentSpec;
const coinRing = coinRingSpec as EquipmentSpec;

// inventory.ts의 effectiveSpec과 동일 로직 — 헤드리스 테스트가 web 의존성 안 끌어오게 직접 구현.
function applyEnhance(base: EquipmentSpec, level: number): EquipmentSpec {
  if (level <= 0 || !base.enhanceDelta) return base;
  const d = base.enhanceDelta;
  const eff: EquipmentSpec = { id: base.id, name: base.name };
  if (base.runSpeedMult !== undefined || d.runSpeedMult)
    eff.runSpeedMult = (base.runSpeedMult ?? 1) + (d.runSpeedMult ?? 0) * level;
  if (base.jumpVelocityMult !== undefined || d.jumpVelocityMult)
    eff.jumpVelocityMult =
      (base.jumpVelocityMult ?? 1) + (d.jumpVelocityMult ?? 0) * level;
  if (base.healDashSeconds !== undefined || d.healDashSeconds)
    eff.healDashSeconds =
      (base.healDashSeconds ?? 0) + (d.healDashSeconds ?? 0) * level;
  if (base.coinValueMult !== undefined || d.coinValueMult)
    eff.coinValueMult =
      (base.coinValueMult ?? 1) + (d.coinValueMult ?? 0) * level;
  return eff;
}

interface BenchLoadout {
  label: string;
  equipName: string; // 장비 이름 (그룹핑용)
  level: number; // 강화 레벨
  loadout: Loadout;
}

function makeBuild(
  equipName: string,
  base: EquipmentSpec,
  level: number,
): BenchLoadout {
  const eq = applyEnhance(base, level);
  return {
    label: `${equipName} +${level}`,
    equipName,
    level,
    loadout: {
      character: defaultC,
      pet: destroyer,
      equipment: [eq, eq, eq],
    },
  };
}

const LOADOUTS: BenchLoadout[] = [];
for (const lv of LV_TIERS) LOADOUTS.push(makeBuild("신발×3", shoes, lv));
for (const lv of LV_TIERS) LOADOUTS.push(makeBuild("회복부적×3", healTalisman, lv));
for (const lv of LV_TIERS) LOADOUTS.push(makeBuild("코인링×3", coinRing, lv));

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const MAX_TICKS = Math.round(DURATION_SECONDS / TICK_DURATION);
const DEATH_PENALTY_TICKS = Math.round(DEATH_PENALTY_SECONDS / TICK_DURATION);

function totalCoinMult(loadout: Loadout): number {
  let bonus = 0;
  for (const e of loadout.equipment) {
    if (e.coinValueMult !== undefined) bonus += e.coinValueMult - 1;
  }
  return 1 + bonus;
}

interface MeasurementResult {
  coins: number;
  cycles: number;
  deaths: number;
  cycleSecs: number[];
  reachedCap: boolean;
}

function runMeasurement(seed: number, loadout: Loadout): MeasurementResult {
  const innerRng = new Rng(seed);
  const mult = totalCoinMult(loadout);
  let elapsedTicks = 0;
  let totalCoins = 0;
  let cycles = 0;
  let deaths = 0;
  const cycleSecs: number[] = [];
  let reachedCap = false;
  while (elapsedTicks < MAX_TICKS) {
    const cycleSeed = innerRng.nextInt(0, 0x7fffffff);
    const w = createWorld(cycleSeed, trackPool, loadout);
    let cycleTicks = 0;
    while (w.runner.alive && elapsedTicks + cycleTicks < MAX_TICKS) {
      step(w, decide(w));
      cycleTicks++;
    }
    totalCoins += w.runner.coins * mult;
    elapsedTicks += cycleTicks;
    cycles++;
    cycleSecs.push(cycleTicks * TICK_DURATION);
    if (!w.runner.alive) {
      deaths++;
      elapsedTicks += DEATH_PENALTY_TICKS;
    } else {
      reachedCap = true;
    }
  }
  return {
    coins: Math.floor(totalCoins),
    cycles,
    deaths,
    cycleSecs,
    reachedCap,
  };
}

interface BenchStats {
  label: string;
  equipName: string;
  level: number;
  coinsPerMinute: number;
  meanCycles: number;
  meanCycleSec: number;
  meanDeaths: number;
  infiniteRunCount: number;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function benchOne(bl: BenchLoadout): BenchStats {
  const rng = new Rng(SEED_START);
  const coinsArr: number[] = [];
  const cyclesArr: number[] = [];
  const deathsArr: number[] = [];
  const allCycleSecs: number[] = [];
  let infiniteRunCount = 0;
  for (let i = 0; i < SEED_COUNT; i++) {
    const measurementSeed = rng.nextInt(0, 0x7fffffff);
    const res = runMeasurement(measurementSeed, bl.loadout);
    coinsArr.push(res.coins);
    cyclesArr.push(res.cycles);
    deathsArr.push(res.deaths);
    for (const s of res.cycleSecs) allCycleSecs.push(s);
    if (res.deaths === 0 && res.reachedCap) infiniteRunCount++;
  }
  const minutesPer = DURATION_SECONDS / 60;
  return {
    label: bl.label,
    equipName: bl.equipName,
    level: bl.level,
    coinsPerMinute: mean(coinsArr) / minutesPer,
    meanCycles: mean(cyclesArr),
    meanCycleSec: mean(allCycleSecs),
    meanDeaths: mean(deathsArr),
    infiniteRunCount,
  };
}

function pad(s: string, n: number): string {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

describe("강화 레벨별 벤치마크", () => {
  it(`${LOADOUTS.length}개 빌드 × ${SEED_COUNT}측정 × ${DURATION_SECONDS}초`, () => {
    const stats = LOADOUTS.map(benchOne);

    const lines: string[] = [];
    lines.push("");
    lines.push(
      `=== 강화별 벤치마크 — ${SEED_COUNT}측정 × ${DURATION_SECONDS}초/측정 (시작 시드=${SEED_START}) ===`,
    );

    // 장비별 그룹핑 출력 — 강화 레벨 순서대로
    const equipNames = Array.from(new Set(stats.map((s) => s.equipName)));
    for (const name of equipNames) {
      lines.push("");
      lines.push(`▶ ${name}`);
      const header =
        pad("강화", 8) +
        pad("코인/분", 14) +
        pad("사이클수", 10) +
        pad("사이클시간", 12) +
        pad("측정당사망", 12) +
        "무한런";
      lines.push(header);
      lines.push("-".repeat(header.length + 8));
      const group = stats
        .filter((s) => s.equipName === name)
        .sort((a, b) => a.level - b.level);
      const baseline = group[0]!;
      for (const s of group) {
        const delta =
          s.level === 0
            ? ""
            : `  (${s.coinsPerMinute >= baseline.coinsPerMinute ? "+" : ""}${fmt(
                ((s.coinsPerMinute - baseline.coinsPerMinute) / baseline.coinsPerMinute) * 100,
                1,
              )}%)`;
        lines.push(
          pad(`+${s.level}`, 8) +
            pad(fmt(s.coinsPerMinute, 1) + delta, 14) +
            pad(fmt(s.meanCycles, 1), 10) +
            pad(fmt(s.meanCycleSec, 1) + "초", 12) +
            pad(fmt(s.meanDeaths, 1), 12) +
            (s.infiniteRunCount > 0 ? `${s.infiniteRunCount}/${SEED_COUNT}` : "-"),
        );
      }
    }

    // 전체 순위 — 강함만 한눈에
    lines.push("");
    lines.push("--- 전체 코인/분 순위 ---");
    const sorted = [...stats].sort((a, b) => b.coinsPerMinute - a.coinsPerMinute);
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i]!;
      const tag = s.infiniteRunCount > 0 ? ` 🟢무한런 ${s.infiniteRunCount}/${SEED_COUNT}` : "";
      lines.push(
        `  ${pad(String(i + 1), 4)}${pad(s.label, 22)}${fmt(s.coinsPerMinute, 1)}${tag}`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }, /* timeout 10분 */ 10 * 60 * 1000);
});
