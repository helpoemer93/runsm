// BugReport.txt 4건 재현 회귀 test.
// 머루+누룽지+신발×3 lv30 극단 세팅에서 첫 obstacle 옆면 충돌 발생하던 케이스.
// 원인: 봇 회피점프 발동 시 다음 obstacle avoidHighMin 미달로 nextObstacleTooClose skip →
//   봇 walking 유지 → 첫 obstacle 옆면 충돌 (30 데미지) → 여러 번 반복 → 사망.
// fix: nextObstacleTooClose 판정에 canDoubleJumpClear 이단점프 통과 검사 추가.
//   봇 정점에서 이단점프 발동으로 다음 obstacle 통과 가능하면 회피 skip 안 함.
// 벤치 (6 시드 × 500판): 사망 63 → 0 (황태), 102 → 0 (머루).

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
const shoes30 = applyEnhance(shoesBase as EquipmentSpec, 30);
const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];
const LOADOUT: Loadout = {
  character: meru as CharacterSpec,
  pet: nurungji as PetSpec,
  equipment: [shoes30, shoes30, shoes30],
};

// 4개 리포트 시드 각각에 대해 최소 tick까지 시뮬 후 충돌 카운트 확인.
// hp 손실 임계값: 시간 데미지 5/s. 리포트 tick까지 초 × 5 데미지가 허용치.
// 옆면 충돌은 +30 데미지 → 시간 데미지 넘는 hp 손실이면 옆면 충돌 있었다는 뜻.
const CASES: { id: string; seed: number; upToTick: number }[] = [
  { id: "#1", seed: 1639008342, upToTick: 200 }, // 첫 obstacle 지날 때까지
  { id: "#2", seed: 1639008342, upToTick: 200 },
  { id: "#3", seed: 1424073679, upToTick: 200 },
  { id: "#4", seed: 1396055658, upToTick: 200 },
];

describe("BugReport 신발×3 lv30 옆면 충돌 회귀", () => {
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
      expect(collisions, `봇이 초반 ${c.upToTick} tick 안 obstacle 옆면 충돌 발생 — nextObstacleTooClose fix 회귀`).toBe(0);
    });
  }
});
