// seed 1565178987 두 시나리오 비교:
//   (A) 기존: fix #12 트레이드오프로 L 부딪힘 선택
//   (B) 대안: nextObstacleTooClose 검사 무시 → 회피점프 발동
// 최종 코인·hp·사이클 시간 비교.
// bot.ts에 강제 회피 옵션 없어 대안 시나리오는 결과 관찰 어려움 →
// 우선 시나리오 (A) 결과만 기록해 사용자 관찰(이득 1 코인) 검증.

import { describe, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import defaultChar from "../src/data/characters/hwangtae.json";
import destroyerPet from "../src/data/pets/nurungji.json";
import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

const trackPool: Stage[] = [stage1 as Stage, stage2 as Stage, stage3 as Stage, stage4 as Stage];

const loadout: Loadout = {
  character: defaultChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

const SEED = 1565178987;

describe("seed 1565178987 fix #12 트레이드오프 판단 검증", () => {
  it("사망 tick 495 전후 봇 코인·hp 흐름", () => {
    const w = createWorld(SEED, trackPool, loadout);
    let tick = 0;
    let coinsAtCollision = -1;
    let hpAtCollision = -1;
    let collisionTick = -1;
    // 충돌 발생 순간 스냅샷 + 이후 30tick 코인 흐름
    while (w.runner.alive && tick < 700) {
      step(w, decide(w));
      tick++;
      if (w.lastCollision && collisionTick < 0) {
        collisionTick = tick;
        coinsAtCollision = w.runner.coins;
        hpAtCollision = w.runner.hp;
        console.log(
          `충돌 tick=${tick} obstacleIdx=${w.lastCollision.obstacleIdx} runner(x=${w.runner.x.toFixed(1)},y=${w.runner.y.toFixed(1)}) coins=${coinsAtCollision} hp=${hpAtCollision.toFixed(1)} invincibleTicks=${w.runner.invincibleTicks}`,
        );
      }
    }
    console.log(
      `사망 tick=${tick} 최종 coins=${w.runner.coins} hp=${w.runner.hp.toFixed(1)} totalDistance=${w.runner.totalDistance.toFixed(0)}`,
    );
    console.log(
      `충돌~사망 사이 tick ${tick - collisionTick} 동안 획득 코인 = ${w.runner.coins - coinsAtCollision}`,
    );
  });
});
