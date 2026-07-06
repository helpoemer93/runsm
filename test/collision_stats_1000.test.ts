// 1000 사이클 헤드리스 시뮬 — 로드아웃별 충돌·사망 통계.
// 사용자 요청: "1000판당 충돌 얼마나 일어나는지".
// 판 = 한 사이클 (createWorld → 봇 사망 or 사이클 상한 도달).
// 무한런 방지 위해 사이클당 상한 시간 둠(MAX_CYCLE_SECONDS).

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

const SEED_START = 42;
const CYCLES_PER_LOADOUT = 1000;
const MAX_CYCLE_SECONDS = 120; // 사이클 상한 (봇 안 죽으면 컷)

const defaultC = defaultChar as CharacterSpec;
const coinWalkerC = coinWalkerChar as CharacterSpec;
const destroyer = destroyerPet as PetSpec;
const firework = fireworkPet as PetSpec;
const shoes = shoesSpec as EquipmentSpec;
const healTalisman = healTalismanSpec as EquipmentSpec;
const coinRing = coinRingSpec as EquipmentSpec;

interface BenchLoadout {
  label: string;
  loadout: Loadout;
}

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
    label: "코인워커+destroyer (장비없음)",
    loadout: { character: coinWalkerC, pet: destroyer, equipment: [] },
  },
  {
    label: "코인워커+firework (장비없음)",
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

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const MAX_CYCLE_TICKS = Math.round(MAX_CYCLE_SECONDS / TICK_DURATION);

interface CycleStats {
  totalCollisions: number; // 사이클 안 발생한 충돌 tick 합계
  collisionDeaths: number; // 마지막 충돌로 사망
  pitDeaths: number; // pit 낙사 사망
  timeDeaths: number; // hp 시간 데미지로 사망 (충돌·pit 아님)
  survived: number; // 사이클 상한까지 살아남음
  totalCycleSecs: number; // 사이클 시간 합 (평균 계산용)
}

function runCycles(loadout: Loadout): CycleStats {
  const rng = new Rng(SEED_START);
  const stats: CycleStats = {
    totalCollisions: 0,
    collisionDeaths: 0,
    pitDeaths: 0,
    timeDeaths: 0,
    survived: 0,
    totalCycleSecs: 0,
  };

  for (let i = 0; i < CYCLES_PER_LOADOUT; i++) {
    const seed = rng.nextInt(0, 0x7fffffff);
    const w = createWorld(seed, trackPool, loadout);
    let ticks = 0;
    while (w.runner.alive && ticks < MAX_CYCLE_TICKS) {
      step(w, decide(w));
      ticks++;
      if (w.lastCollision) stats.totalCollisions++;
    }
    stats.totalCycleSecs += ticks * TICK_DURATION;
    if (!w.runner.alive) {
      if (w.lastCollision) stats.collisionDeaths++;
      else if (w.lastPitFall) stats.pitDeaths++;
      else stats.timeDeaths++;
    } else {
      stats.survived++;
    }
  }

  return stats;
}

function pad(s: string, n: number): string {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

describe("1000판 충돌·사망 통계", () => {
  it(
    `${LOADOUTS.length}개 로드아웃 × ${CYCLES_PER_LOADOUT}판 (사이클 상한 ${MAX_CYCLE_SECONDS}초)`,
    () => {
      const results = LOADOUTS.map((bl) => ({
        label: bl.label,
        stats: runCycles(bl.loadout),
      }));

      const lines: string[] = [];
      lines.push("");
      lines.push(
        `=== 1000판 충돌·사망 통계 (시작 시드=${SEED_START}, 사이클 상한 ${MAX_CYCLE_SECONDS}초) ===`,
      );
      lines.push("");

      const header =
        pad("로드아웃", 34) +
        pad("총충돌", 8) +
        pad("판당충돌", 10) +
        pad("충돌사망", 10) +
        pad("pit사망", 9) +
        pad("시간사망", 10) +
        pad("생존", 6) +
        "평균사이클(초)";
      lines.push(header);
      lines.push("-".repeat(header.length + 4));
      for (const r of results) {
        const s = r.stats;
        const totalDeaths = s.collisionDeaths + s.pitDeaths + s.timeDeaths;
        const perCycle = s.totalCollisions / CYCLES_PER_LOADOUT;
        const avgSec = s.totalCycleSecs / CYCLES_PER_LOADOUT;
        lines.push(
          pad(r.label, 34) +
            pad(s.totalCollisions.toString(), 8) +
            pad(fmt(perCycle, 2), 10) +
            pad(s.collisionDeaths.toString(), 10) +
            pad(s.pitDeaths.toString(), 9) +
            pad(s.timeDeaths.toString(), 10) +
            pad(s.survived.toString(), 6) +
            fmt(avgSec, 1) +
            (totalDeaths === 0 ? " (전판생존)" : ""),
        );
      }

      lines.push("");
      lines.push(
        `주: "총충돌"은 모든 사이클 tick 안 충돌 이벤트 합. 한 사이클에 여러 번 부딪힐 수 있음(각 충돌 후 60틱 무적).`,
      );
      lines.push(
        `    "충돌사망"은 마지막 충돌로 hp 0 도달한 사이클 수. "시간사망"은 hp 시간 데미지만으로 사망한 사이클 수.`,
      );
      lines.push(
        `    "생존"은 ${MAX_CYCLE_SECONDS}초 상한까지 살아남은 사이클 수 (봇이 트랙 wrap하며 계속 달림).`,
      );

      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
    },
    10 * 60 * 1000,
  );
});
