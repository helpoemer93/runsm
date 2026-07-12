// 신발 강화 극단 세팅 4 로드아웃 × 5000판 = 20000판 벤치.
// 목적: memory 100000판 벤치와 비례 비교로 스코어러 fix(무적 아이템만 충돌 감수)의
//   부작용 검증. 총충돌·사망 카운트가 감소했는지 확인.
// 실행 시간 ≈ 10분. CI 대상 아님 — 명시적으로 실행.
//
// memory 100000판 벤치(2026-07-12, fix 이전) 참고 수치:
//   머루 lv20: 총충돌 10, 사망 0
//   황태 lv20: 총충돌 15, 사망 2
//   머루 lv30: 총충돌 23, 사망 4
//   황태 lv30: 총충돌 28, 사망 6
//   총 76 / 12
// 이번 벤치는 20000판 규모(1/5) → 예상치도 1/5.

import { describe, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import type { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import type { Stage } from "../src/sim/stage";
import { Rng } from "../src/sim/rng";
import hwangtae from "../src/data/characters/hwangtae.json";
import meru from "../src/data/characters/meru.json";
import nurungji from "../src/data/pets/nurungji.json";
import shoesBase from "../src/data/equipment/shoes.json";
import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

function applyEnhance(base: EquipmentSpec, level: number): EquipmentSpec {
  if (level <= 0 || !base.enhanceDelta) return base;
  const d = base.enhanceDelta;
  const eff: EquipmentSpec = { id: base.id, name: base.name };
  if (base.runSpeedMult !== undefined || d.runSpeedMult)
    eff.runSpeedMult = (base.runSpeedMult ?? 1) + (d.runSpeedMult ?? 0) * level;
  return eff;
}
const shoes20 = applyEnhance(shoesBase as EquipmentSpec, 20);
const shoes30 = applyEnhance(shoesBase as EquipmentSpec, 30);
const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const LOADOUTS: { label: string; loadout: Loadout }[] = [
  {
    label: "머루+누룽지+신발×3 lv20",
    loadout: { character: meru as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes20, shoes20, shoes20] },
  },
  {
    label: "황태+누룽지+신발×3 lv20",
    loadout: { character: hwangtae as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes20, shoes20, shoes20] },
  },
  {
    label: "머루+누룽지+신발×3 lv30",
    loadout: { character: meru as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes30, shoes30, shoes30] },
  },
  {
    label: "황태+누룽지+신발×3 lv30",
    loadout: { character: hwangtae as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes30, shoes30, shoes30] },
  },
];

const SEED_START = 42;
const CYCLES_PER_LOADOUT = 5000; // memory 100000판 벤치의 1/5 규모
const MAX_CYCLE_SECONDS = 120;
const MAX_CYCLE_TICKS = Math.round(MAX_CYCLE_SECONDS / TICK_DURATION);

interface CycleStats {
  totalCollisions: number;
  collisionDeaths: number;
  pitDeaths: number;
  timeDeaths: number;
  survived: number;
  totalCycleSecs: number;
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

describe("신발 극단 세팅 20000판 벤치 (스코어러 무적 fix)", () => {
  it(
    `4 로드아웃 × ${CYCLES_PER_LOADOUT}판 (총 ${LOADOUTS.length * CYCLES_PER_LOADOUT}판)`,
    () => {
      const results = LOADOUTS.map((bl) => ({
        label: bl.label,
        stats: runCycles(bl.loadout),
      }));
      const lines: string[] = [];
      lines.push("");
      lines.push(
        `=== 신발 극단 세팅 20000판 벤치 (시작 시드=${SEED_START}, 사이클 상한 ${MAX_CYCLE_SECONDS}초) ===`,
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
      let totalColl = 0;
      let totalCollDeath = 0;
      for (const r of results) {
        const s = r.stats;
        const perCycle = s.totalCollisions / CYCLES_PER_LOADOUT;
        const avgSec = s.totalCycleSecs / CYCLES_PER_LOADOUT;
        totalColl += s.totalCollisions;
        totalCollDeath += s.collisionDeaths;
        lines.push(
          pad(r.label, 34) +
            pad(s.totalCollisions.toString(), 8) +
            pad(perCycle.toFixed(4), 10) +
            pad(s.collisionDeaths.toString(), 10) +
            pad(s.pitDeaths.toString(), 9) +
            pad(s.timeDeaths.toString(), 10) +
            pad(s.survived.toString(), 6) +
            avgSec.toFixed(1),
        );
      }
      lines.push("-".repeat(header.length + 4));
      lines.push(`총계: 총충돌 ${totalColl}, 충돌사망 ${totalCollDeath}`);
      lines.push("");
      lines.push(
        `참고: fix 이전 100000판 벤치(2026-07-12) — 총충돌 76 / 사망 12. 규모 1/5 → 예상 15/2 미만이면 부작용 없음.`,
      );
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
    },
    15 * 60 * 1000,
  );
});
