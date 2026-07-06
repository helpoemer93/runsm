// 헤드리스 파밍 효율 벤치마크 — 각 로드아웃에 대해 SEED_COUNT개 시드로 정확히
// DURATION_SECONDS초씩 다중 사이클 시뮬해서 시간당 코인을 비교한다.
//
// 측정 방식 (사용자 디자인 — 사망 패널티 5초만, 시간당 코인이 핵심):
// - 한 측정 = DURATION_SECONDS초 동안 사이클 반복.
// - 봇 사망 시 DEATH_PENALTY_SECONDS초 시간 카운트 후 새 시드로 createWorld 재시작.
// - 분당 코인 = 누적 코인 / DURATION_SECONDS * 60 (사망 패널티 포함)
// - 측정 시간 동안 한 번도 안 죽는 빌드는 사이클 1개로 측정됨 → "무한 런" 신호.
//
// 일회성 측정 도구. 회귀에서 제외하려면 `npx vitest run --exclude test/bench.test.ts ...`
// 또는 직접 `npx vitest run test/bench.test.ts` 호출.

import { describe, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
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
const SEED_START = 42; // 측정 시드 시퀀스의 시작 시드 (결정론 — 같은 값이면 같은 결과)
const SEED_COUNT = 50; // 측정 표본 수 (각 측정은 독립)
const DURATION_SECONDS = 300; // 한 측정 시간 — 무한 런 빌드 식별 위해 충분히 김
const DEATH_PENALTY_SECONDS = 5; // 사망 시 다음 사이클 시작까지 5초 대기 (main.ts와 동일)

interface BenchLoadout {
  label: string;
  loadout: Loadout;
}

const defaultC = defaultChar as CharacterSpec;
const coinWalkerC = coinWalkerChar as CharacterSpec;
const destroyer = destroyerPet as PetSpec;
const firework = fireworkPet as PetSpec;
const shoes = shoesSpec as EquipmentSpec;
const healTalisman = healTalismanSpec as EquipmentSpec;
const coinRing = coinRingSpec as EquipmentSpec;

const LOADOUTS: BenchLoadout[] = [
  {
    label: "기본+destroyer (장비없음)",
    loadout: { character: defaultC, pet: destroyer, equipment: [] },
  },
  {
    label: "기본+firework (장비없음)",
    loadout: { character: defaultC, pet: firework, equipment: [] },
  },
  {
    label: "coin-walker+destroyer (장비없음)",
    loadout: { character: coinWalkerC, pet: destroyer, equipment: [] },
  },
  {
    label: "coin-walker+firework (장비없음)",
    loadout: { character: coinWalkerC, pet: firework, equipment: [] },
  },
  {
    label: "기본+destroyer+신발×3",
    loadout: { character: defaultC, pet: destroyer, equipment: [shoes, shoes, shoes] },
  },
  {
    label: "기본+destroyer+회복부적×3",
    loadout: { character: defaultC, pet: destroyer, equipment: [healTalisman, healTalisman, healTalisman] },
  },
  {
    label: "기본+destroyer+코인링×3",
    loadout: { character: defaultC, pet: destroyer, equipment: [coinRing, coinRing, coinRing] },
  },
];
// ───────────────────────────────────────────────────────

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const MAX_TICKS = Math.round(DURATION_SECONDS / TICK_DURATION);
const DEATH_PENALTY_TICKS = Math.round(DEATH_PENALTY_SECONDS / TICK_DURATION);

// 결과창에서만 적용되는 코인 배율 — main.ts의 totalCoinMult와 동일 정의 (합연산).
function totalCoinMult(loadout: Loadout): number {
  let bonus = 0;
  for (const e of loadout.equipment) {
    if (e.coinValueMult !== undefined) bonus += e.coinValueMult - 1;
  }
  return 1 + bonus;
}

interface MeasurementResult {
  coins: number; // coinValueMult 적용된 누적 코인 (측정 전체)
  cycles: number;
  deaths: number;
  collisionDeaths: number;
  pitDeaths: number;
  timeDeaths: number;
  collisions: number; // 측정 동안 모든 사이클 충돌 합산
  cycleSecs: number[]; // 사이클별 시간 (초)
  reachedCap: boolean; // 측정 종료가 cap 도달 (생존) 때문이면 true
}

// 한 측정 — DURATION_SECONDS초 동안 사이클 반복.
function runMeasurement(measurementSeed: number, loadout: Loadout): MeasurementResult {
  const innerRng = new Rng(measurementSeed);
  const mult = totalCoinMult(loadout);

  let elapsedTicks = 0;
  let totalCoins = 0;
  let cycles = 0;
  let deaths = 0;
  let collisionDeaths = 0;
  let pitDeaths = 0;
  let timeDeaths = 0;
  let totalCollisions = 0;
  const cycleSecs: number[] = [];
  let reachedCap = false;

  while (elapsedTicks < MAX_TICKS) {
    const cycleSeed = innerRng.nextInt(0, 0x7fffffff);
    const w = createWorld(cycleSeed, trackPool, loadout);
    let cycleTicks = 0;
    while (w.runner.alive && elapsedTicks + cycleTicks < MAX_TICKS) {
      step(w, decide(w));
      cycleTicks++;
      if (w.lastCollision) totalCollisions++;
    }
    totalCoins += w.runner.coins * mult;
    elapsedTicks += cycleTicks;
    cycles++;
    cycleSecs.push(cycleTicks * TICK_DURATION);

    if (!w.runner.alive) {
      // 사망 처리
      deaths++;
      if (w.lastCollision) collisionDeaths++;
      else if (w.lastPitFall) pitDeaths++;
      else timeDeaths++;
      // 사망 패널티 (다음 사이클까지 5초 대기) — 단 cap 넘는 부분은 잘림
      elapsedTicks += DEATH_PENALTY_TICKS;
    } else {
      // 살아있는데 사이클 종료 = cap 도달
      reachedCap = true;
    }
  }

  return {
    coins: Math.floor(totalCoins),
    cycles,
    deaths,
    collisionDeaths,
    pitDeaths,
    timeDeaths,
    collisions: totalCollisions,
    cycleSecs,
    reachedCap,
  };
}

interface BenchStats {
  label: string;
  meanCoins: number;
  stdCoins: number;
  coinsPerMinute: number;
  stdCoinsPerMinute: number;
  meanCycles: number;
  meanDeaths: number;
  meanCollisions: number;
  meanCycleSec: number;
  collisionDeathFrac: number; // 충돌사망 / 전체사망 (사망이 있을 때만 유의)
  pitDeathFrac: number; // pit 낙사 / 전체사망
  timeDeathFrac: number;
  infiniteRunCount: number; // 측정 동안 0번 사망한 시드 수
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function std(xs: number[], m: number): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

function benchOne(bl: BenchLoadout): BenchStats {
  const rng = new Rng(SEED_START);
  const coinsArr: number[] = [];
  const cyclesArr: number[] = [];
  const deathsArr: number[] = [];
  const collisionsArr: number[] = [];
  const allCycleSecs: number[] = [];
  let totalCollisionDeaths = 0;
  let totalPitDeaths = 0;
  let totalTimeDeaths = 0;
  let infiniteRunCount = 0;

  for (let i = 0; i < SEED_COUNT; i++) {
    const measurementSeed = rng.nextInt(0, 0x7fffffff);
    const res = runMeasurement(measurementSeed, bl.loadout);
    coinsArr.push(res.coins);
    cyclesArr.push(res.cycles);
    deathsArr.push(res.deaths);
    collisionsArr.push(res.collisions);
    for (const s of res.cycleSecs) allCycleSecs.push(s);
    totalCollisionDeaths += res.collisionDeaths;
    totalPitDeaths += res.pitDeaths;
    totalTimeDeaths += res.timeDeaths;
    if (res.deaths === 0 && res.reachedCap) infiniteRunCount++;
  }

  const m = mean(coinsArr);
  const minutesPerMeasurement = DURATION_SECONDS / 60;
  const cpmArr = coinsArr.map((c) => c / minutesPerMeasurement);
  const mCpm = mean(cpmArr);
  const totalDeaths =
    totalCollisionDeaths + totalPitDeaths + totalTimeDeaths;

  return {
    label: bl.label,
    meanCoins: m,
    stdCoins: std(coinsArr, m),
    coinsPerMinute: mCpm,
    stdCoinsPerMinute: std(cpmArr, mCpm),
    meanCycles: mean(cyclesArr),
    meanDeaths: mean(deathsArr),
    meanCollisions: mean(collisionsArr),
    meanCycleSec: mean(allCycleSecs),
    collisionDeathFrac: totalDeaths > 0 ? totalCollisionDeaths / totalDeaths : 0,
    pitDeathFrac: totalDeaths > 0 ? totalPitDeaths / totalDeaths : 0,
    timeDeathFrac: totalDeaths > 0 ? totalTimeDeaths / totalDeaths : 0,
    infiniteRunCount,
  };
}

function pad(s: string, n: number): string {
  // 한글은 폭이 2 — 시각적 정렬 위해 폭 보정
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

describe("벤치마크", () => {
  it(`${LOADOUTS.length}개 로드아웃 × ${SEED_COUNT}측정 × ${DURATION_SECONDS}초`, () => {
    const stats = LOADOUTS.map(benchOne);

    const lines: string[] = [];
    lines.push("");
    lines.push(
      `=== 벤치마크 — ${SEED_COUNT}측정 × ${DURATION_SECONDS}초/측정, 사망 패널티 ${DEATH_PENALTY_SECONDS}초 (시작 시드=${SEED_START}) ===`,
    );
    lines.push("");

    // 효율 순(분당 코인) 정렬
    const sorted = [...stats].sort((a, b) => b.coinsPerMinute - a.coinsPerMinute);

    const header =
      pad("로드아웃", 38) +
      pad("코인/분", 14) +
      pad("표준편차", 14) +
      pad("사이클수", 10) +
      pad("사이클시간", 12) +
      "무한런";
    lines.push(header);
    lines.push("-".repeat(header.length + 8));
    for (const s of sorted) {
      lines.push(
        pad(s.label, 38) +
          pad(fmt(s.coinsPerMinute, 1), 14) +
          pad("±" + fmt(s.stdCoinsPerMinute, 1), 14) +
          pad(fmt(s.meanCycles, 1), 10) +
          pad(fmt(s.meanCycleSec, 1) + "초", 12) +
          (s.infiniteRunCount > 0 ? `${s.infiniteRunCount}/${SEED_COUNT}` : "-"),
      );
    }

    // 사망 원인 분석
    lines.push("");
    lines.push("--- 사망 원인 분석 ---");
    const causeHeader =
      pad("로드아웃", 38) +
      pad("측정당사망", 12) +
      pad("측정당충돌", 12) +
      pad("충돌사망", 10) +
      pad("pit사망", 10) +
      "시간사망";
    lines.push(causeHeader);
    lines.push("-".repeat(causeHeader.length + 8));
    for (const s of sorted) {
      lines.push(
        pad(s.label, 38) +
          pad(fmt(s.meanDeaths, 1), 12) +
          pad(fmt(s.meanCollisions, 2), 12) +
          pad(fmt(s.collisionDeathFrac * 100, 1) + "%", 10) +
          pad(fmt(s.pitDeathFrac * 100, 1) + "%", 10) +
          fmt(s.timeDeathFrac * 100, 1) + "%",
      );
    }

    // 최강 빌드 대비 상대 효율
    lines.push("");
    lines.push("--- 최강 빌드 대비 상대 효율 (코인/분 기준) ---");
    const top = sorted[0]!;
    for (const s of sorted) {
      const ratio = (s.coinsPerMinute / top.coinsPerMinute) * 100;
      lines.push(`  ${pad(s.label, 38)} ${fmt(ratio, 1)}%`);
    }

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }, /* timeout 10분 — 큰 SEED_COUNT × DURATION 대비 */ 10 * 60 * 1000);
});
