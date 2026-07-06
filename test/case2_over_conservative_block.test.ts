// blockingObstacleAhead case (2)가 너무 보수적으로 봇 catch jump 차단하던 케이스.
// 봇 flight 후 착지에서 obstacle까지 gap > triggerMin이면 봇 walking으로 avoid 가능한데
// 기존 로직은 gap이 triggerMax 이내이기만 하면 차단. 실제로는 gap [triggerMin, triggerMax]
// 는 봇 walking + trigger로 안전. gap < triggerMin만 차단 대상.

import { describe, it, expect } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import defaultChar from "../src/data/characters/hwangtae.json";
import destroyerPet from "../src/data/pets/nurungji.json";

const stage: Stage = {
  id: "test",
  length: 3000,
  obstacles: [
    // 봇 flight 끝나고 gap 50 (triggerMin=20 이상, triggerMax=70 이하) 위치에 지면 obstacle.
    // 봇 walking으로 gap 50→20 진입 시 avoid_low trigger 발동 → 안전.
    // 기존 로직: gap ≤ 70 이면 차단 → 봇 catch jump 안 함 → 코인 놓침.
    { x: 500, width: 50, height: 30 },
  ],
  items: [
    // 봇 (250, 0) 근처에서 잡을 공중 v=5 코인.
    // gap 20~70 trigger zone. y > baseHeight. canCatchGround 성공.
    { x: 275, y: 100, value: 5 },
  ],
  baseSpeed: 300,
};

const loadout: Loadout = {
  character: defaultChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

describe("blockingObstacleAhead case(2) triggerMin 기준 완화", () => {
  it("봇 착지 후 gap ≥ triggerMin obstacle이면 catch jump 발동", () => {
    const w = createWorld(1, [stage], loadout);
    let tick = 0;
    while (w.runner.alive && tick < 300) {
      const input = decide(w);
      step(w, input);
      tick++;
      if (w.runner.x > 700) break;
    }
    const coinCollected = w.currentItemCollected[0];
    console.log(`v=5 (275, 100) 수집=${coinCollected ? "O" : "X"}`);
    expect(coinCollected).toBe(true);
  });
});
