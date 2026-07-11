// BugReport.txt lv20 리포트 2건 + 사망 시드 3건 재현 회귀 test.
// 머루+누룽지+신발×3 lv20 극단 세팅에서 obstacle 옆면 충돌 → 사망 케이스.
// 원인: hasGroundItemBefore 지연 후 다음 obstacle nextObstacleTooClose 활성화 →
//   회피 skip → 옆면 충돌.
// fix: 지연 판정 시 지연 후 봇 위치(이산 tick 반영) 기준으로 nextObstacleTooClose
//   재검증. 지연 후 회피 못 하면 지금 즉시 회피 발동.

import { describe, it, expect } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import type { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import type { Stage } from "../src/sim/stage";
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
const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];
const LOADOUT: Loadout = {
  character: meru as CharacterSpec,
  pet: nurungji as PetSpec,
  equipment: [shoes20, shoes20, shoes20],
};

// 리포트 2건 + 사망 시드 대표 3개 (황태·머루 공통).
const CASES: { id: string; seed: number; upToTick: number }[] = [
  { id: "리포트#1", seed: 825567814, upToTick: 800 },
  { id: "리포트#2", seed: 2099162435, upToTick: 2600 },
  { id: "사망 시드 A", seed: 1175943786, upToTick: 1200 },
  { id: "사망 시드 B", seed: 1150755217, upToTick: 2400 },
  { id: "사망 시드 C", seed: 589897909, upToTick: 3000 },
];

describe("BugReport 신발×3 lv20 옆면 충돌 회귀", () => {
  for (const c of CASES) {
    it(`${c.id} 시드 ${c.seed} 초반 ${c.upToTick} tick 옆면 충돌 없음`, () => {
      const w = createWorld(c.seed, trackPool, LOADOUT);
      let ticks = 0;
      let collisions = 0;
      while (w.runner.alive && ticks < c.upToTick) {
        step(w, decide(w));
        ticks++;
        if (w.lastCollision) collisions++;
      }
      expect(
        collisions,
        `봇이 초반 ${c.upToTick} tick 안 obstacle 옆면 충돌 발생 — 지연 후 회피 안전 재검증 fix 회귀`,
      ).toBe(0);
    });
  }
});
