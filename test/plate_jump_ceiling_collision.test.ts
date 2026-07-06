// 봇 플랫폼 위에서 점프하면 착지 시점이 천장 obstacle과 겹치는 케이스.
// 두 가지 경우:
// (1) 수집점프/회피점프 → blockingObstacleAhead에서 착지 옆면 충돌 예측해 차단.
// (2) 플랫폼 도약 → 도약 궤도가 obstacle과 겹치면 skip.

import { describe, it, expect } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import coinWalkerChar from "../src/data/characters/meru.json";
import destroyerPet from "../src/data/pets/nurungji.json";

const stage: Stage = {
  id: "test",
  length: 3000,
  obstacles: [
    // 플랫폼 [200, 450], top=80.
    { x: 200, width: 250, height: 80, kind: "platform" },
    // 천장 [640, 800], yBottom=30, height=90.
    // 봇 walking-off: 플랫폼 끝(450) 벗어난 뒤 y=0 낙하 → x=530 착지 → 걸어가 640 앞 슬라이드 발동. 안전.
    // 봇 플랫폼 도약: (400, 80) 점프 궤도 착지 632, body 우측 662 > 640 → 천장 옆면 충돌. 30 데미지.
    { x: 640, width: 160, height: 90, yBottom: 30 },
  ],
  items: [
    // heal at (620, 80) — 플랫폼 도약 궤도 상 유혹.
    // canCatchGround: 봇 (400, 80) jump t=0.733, yAtT=38.8, body[38.8,88.8] contains 80 → true.
    { x: 620, y: 80, effect: "heal" as const },
  ],
  baseSpeed: 300,
};

const loadout: Loadout = {
  character: coinWalkerChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

describe("플랫폼 도약이 천장 obstacle과 충돌 예상이면 skip", () => {
  it("봇이 heal 도약 대신 walking off로 안전 통과 (hp 손실 없음)", () => {
    const w = createWorld(1, [stage], loadout);
    let tick = 0;
    const initialHp = w.runner.maxHp;
    while (w.runner.alive && tick < 300) {
      const input = decide(w);
      step(w, input);
      tick++;
      if (w.runner.x > 900) break;
    }
    // 시간 데미지 5/s * 최대 5초 정도 = 25 이하만 손실.
    const hpLoss = initialHp - w.runner.hp;
    console.log(`hp 손실=${hpLoss.toFixed(1)}, alive=${w.runner.alive}`);
    // 30 데미지 충돌 발생하면 hp 손실 30 이상. 30 미만이면 충돌 안 함.
    expect(hpLoss).toBeLessThan(30);
  });
});
