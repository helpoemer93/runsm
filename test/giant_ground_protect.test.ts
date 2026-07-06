// 봇이 거대화 상태에서 지면·낮은 아이템(y ≤ 100)을 걸어가며 자연 수집할 수 있는데
// nearGroundProtect가 y > baseHeight(50)만 "공중" 취급하면 y=80 heal을 "점프해야 잡는 것"
// 으로 오판하고, 그 heal이 지면 dash보다 priority 높으니 보호 해제 → 봇이 옆의 v=1 코인
// 잡으러 점프 → 지면 dash + heal 두 개 놓침. 재현·회귀 검증.

import { describe, it, expect } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import coinWalkerChar from "../src/data/characters/coin-walker.json";
import destroyerPet from "../src/data/pets/destroyer.json";

const stage: Stage = {
  id: "test",
  length: 5000,
  obstacles: [],
  items: [
    // giant 아이템 (봇 시작 근처)
    { x: 105, y: 0, effect: "giant" as const },
    // 봇이 giant 활성 상태로 도달하는 세 아이템:
    // - 지면 dash (y=0) — giant 몸통에 자연 수집 (walk)
    // - 낮은 heal (y=80) — giant 몸통 안 → 자연 수집
    // - 공중 v=1 코인 (y=180) — giant 몸통이 정점에서 [128, 228] 도달, 잡을 수는 있지만 점프 필요
    { x: 500, y: 0, effect: "dash" as const },
    { x: 550, y: 80, effect: "heal" as const },
    { x: 600, y: 180, value: 1 },
  ],
  baseSpeed: 300,
};

const loadout: Loadout = {
  character: coinWalkerChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

describe("거대화 지면 보호 — y ≤ jbH 아이템 자연 수집 우선", () => {
  it("봇이 v=1 코인(y=180) 잡으러 점프해서 dash+heal 놓치지 않는다", () => {
    const w = createWorld(1, [stage], loadout);
    let tick = 0;
    let jumpedForCoin = false;
    while (w.runner.alive && tick < 300) {
      const input = decide(w);
      if (input.jump && w.runner.giantTicks > 0) jumpedForCoin = true;
      step(w, input);
      tick++;
      if (w.runner.x > 700) break;
    }
    const dashCollected = w.currentItemCollected[1];
    const healCollected = w.currentItemCollected[2];
    const coinCollected = w.currentItemCollected[3];
    console.log(
      `dash(y=0)=${dashCollected ? "O" : "X"}, heal(y=80)=${healCollected ? "O" : "X"}, coin(y=180)=${coinCollected ? "O" : "X"}, 거대화중 점프=${jumpedForCoin}`,
    );
    // 핵심 회귀: dash + heal 두 개 모두 수집. v=1 코인은 tradeoff — 놓쳐도 OK.
    expect(dashCollected).toBe(true);
    expect(healCollected).toBe(true);
  });
});
