// 회귀 test — "비행중 하강" 상태에서 앞 천장 obstacle(yBottom>0) 옆면 충돌 예정을
// 감지하고 회피용 이단점프를 발동하는 fix 회귀 방지.
//
// 이전 로직: bot.ts:1932 branch에서 apexHeadAir(연속시간 정점 top) > oYBottom이면
// 이단점프 skip → 봇 자연 하강해서 obs 옆면 진입.
// fix: 천장 obs를 이산 sim으로 정밀 판정. 봇 자연 궤적이 옆면 진입 예정 +
// 이단점프 궤적이 obs 지붕 안전 통과 가능이면 회피 이단점프 발동.
//
// 대표 시드 3개 — 신발×3 lv30. 사망 케이스 포함.

import { describe, expect, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import type { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import type { Stage } from "../src/sim/stage";
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

const shoes30 = applyEnhance(shoesBase as EquipmentSpec, 30);
const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const CASES = [
  { seed: 121837336, char: meru as CharacterSpec, label: "머루lv30", priorHitTick: 982 },
  { seed: 121837336, char: hwangtae as CharacterSpec, label: "황태lv30", priorHitTick: 982 },
  { seed: 633064635, char: hwangtae as CharacterSpec, label: "황태lv30-사망", priorHitTick: 3643 },
];

const MAX_TICKS = Math.round(120 / TICK_DURATION);

describe("천장 h90 하강 회피 이단점프 fix 회귀", () => {
  for (const c of CASES) {
    it(`${c.label} seed=${c.seed} 초반 ${c.priorHitTick + 100} tick 내 옆면 충돌 없음`, () => {
      const loadout: Loadout = {
        character: c.char,
        pet: nurungji as PetSpec,
        equipment: [shoes30, shoes30, shoes30],
      };
      const w = createWorld(c.seed, trackPool, loadout);
      let tick = 0;
      let collisions = 0;
      const limit = Math.min(MAX_TICKS, c.priorHitTick + 100);
      while (w.runner.alive && tick < limit) {
        step(w, decide(w));
        tick++;
        if (w.lastCollision) collisions++;
      }
      expect(collisions).toBe(0);
    });
  }
});
