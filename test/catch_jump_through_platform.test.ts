// 봇이 앞에 플랫폼이 있어도 그 앞에 있는 공중 코인·heal을 수집점프로 잡아야 함.
// 플랫폼은 world.ts 충돌 loop에서 제외되는 통과 가능 obstacle — 봇이 catch jump 후
// 자연 플랫폼 위 착지하거나 그냥 통과. 벽처럼 차단해서 발동 막으면 근처 지면 아이템 손해.

import { describe, it, expect } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import defaultChar from "../src/data/characters/default.json";
import destroyerPet from "../src/data/pets/destroyer.json";

const stage: Stage = {
  id: "test",
  length: 3000,
  obstacles: [
    // 봇이 도달할 즈음 x=400 부근에 플랫폼 (yTop=80)
    // 봇이 코인 잡으러 점프하면 정점에서 착지 궤도가 플랫폼 위에 놓임 — 자연 안전.
    { x: 500, width: 250, height: 80, kind: "platform" },
  ],
  items: [
    // 봇 앞 코인·heal — 플랫폼 진입 직전 trigger zone에 등장
    // gap 60 y=120 v=5 (코인 워커 baseSpeed 300, trigger zone [20, 70])
    { x: 300, y: 120, value: 5 },
    { x: 320, y: 80, effect: "heal" as const },
  ],
  baseSpeed: 300,
};

const loadout: Loadout = {
  character: defaultChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

describe("플랫폼 앞 공중 아이템 수집점프 차단 안 됨", () => {
  it("봇이 근처 플랫폼 무관하게 v=5·heal 수집점프로 잡음", () => {
    const w = createWorld(1, [stage], loadout);
    let tick = 0;
    while (w.runner.alive && tick < 200) {
      const input = decide(w);
      step(w, input);
      tick++;
      if (w.runner.x > 800) break;
    }
    const coinCollected = w.currentItemCollected[0];
    const healCollected = w.currentItemCollected[1];
    console.log(`v=5 y=120: ${coinCollected ? "O" : "X"}, heal y=80: ${healCollected ? "O" : "X"}`);
    expect(coinCollected).toBe(true);
    expect(healCollected).toBe(true);
  });
});
