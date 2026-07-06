// 빠른 봇(신발×3)이 높은 장애물(h=150)에 옆면 충돌하는 케이스 회귀.
// 시드 818751305 tick 301 obstacle x=2032 옆면 충돌. 봇 단점프 후 vy≤200 진입 시점에
// 이미 obstacle 앞 18px, 보충으로도 3틱 안 y=148<150 부족. 기존 |vy|<=200 gate 제거 +
// 단점프 궤도 충돌 예상일 때만 보충 발동으로 fix.

import { describe, it, expect } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import coinWalkerChar from "../src/data/characters/coin-walker.json";
import destroyerPet from "../src/data/pets/destroyer.json";
import shoesSpec from "../src/data/equipment/shoes.json";
import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const loadout: Loadout = {
  character: coinWalkerChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [shoesSpec, shoesSpec, shoesSpec] as EquipmentSpec[],
};

describe("빠른 봇 h=150 정점 보충 발동", () => {
  it("시드 818751305 tick 300 근처 obstacle idx=5(h=150) 옆면 충돌 안 함", () => {
    const w = createWorld(818751305, trackPool, loadout);
    let tick = 0;
    let collidedWithHighObs = false;
    while (w.runner.alive && tick < 400) {
      const input = decide(w);
      step(w, input);
      if (w.lastCollision) {
        const idx = w.lastCollision.obstacleIdx;
        const o = w.currentTrack.obstacles[idx];
        if (o && o.height === 150 && (o.yBottom ?? 0) === 0) {
          collidedWithHighObs = true;
        }
      }
      tick++;
    }
    console.log(`최종 hp=${w.runner.hp.toFixed(1)}, 높은장애물 옆면 충돌=${collidedWithHighObs}`);
    expect(collidedWithHighObs).toBe(false);
  });
});
