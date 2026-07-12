// 회귀 test — apexTrap 브랜치 이단점프 궤적 판정을 이산 sim으로 교체한 fix 회귀 방지.
// bot.ts:1716 apexTrap 브랜치에서 pit 정점 착지 딜레마 회피용 이단점프 발동 시,
// 앞 지면 h=150 obstacle 통과 여부를 60Hz 이산 sim으로 검사하도록 변경.
// 이전엔 연속시간 공식으로 판정 → 실제 이산 tick 궤적보다 정점 y를 높게 예측 → 옆면 충돌.
//
// 대표 시드 3개(재분류 벤치에서 발견) — 신발×3 lv20 황태 로드아웃.
// fix 이전: 초반 3000 tick 안에 obs h=150 옆면 충돌 (hp 30 손실).
// fix 이후: 충돌 0.

import { describe, expect, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import type { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import type { Stage } from "../src/sim/stage";
import hwangtae from "../src/data/characters/hwangtae.json";
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
const loadout: Loadout = {
  character: hwangtae as CharacterSpec,
  pet: nurungji as PetSpec,
  equipment: [shoes20, shoes20, shoes20],
};

const CASES = [
  { seed: 1347954296, priorHitTick: 2296 },
  { seed: 1829293723, priorHitTick: 2534 },
  { seed: 1358775972, priorHitTick: 953 },
];

const MAX_TICKS = Math.round(60 / TICK_DURATION); // 60초, 사망 판정 아니면 충분

describe("apexTrap 이단점프 궤적 이산 sim fix 회귀", () => {
  for (const c of CASES) {
    it(`seed=${c.seed} 초반 ${c.priorHitTick + 100} tick 내 옆면 충돌 없음`, () => {
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
