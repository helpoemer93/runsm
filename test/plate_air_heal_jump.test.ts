// 봇 플랫폼 위에서 앞 공중 heal(y ≈ 플랫폼 top) 잡기 위해 도약해야 함.
// walking-off 궤도(플랫폼 지나면 y 급락)는 heal 못 잡음 — 단점프 궤도 하강 부분이
// 정렬되면 잡을 수 있음. 이 로직 없으면 봇 plate 위 걸어가다 heal 통과 실패.

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
    // 플랫폼 [500, 750], top=80. 봇 회피점프로 올라탐.
    { x: 500, width: 250, height: 80, kind: "platform" },
  ],
  items: [
    // heal at (820, 80) — 플랫폼 지나 69px 위치 y=플랫폼 top과 동일.
    // 봇 walking-off는 fall 궤도로 y 20 근처에서 heal.x 도달 → body [20, 70] miss heal.y=80.
    // 봇 단점프 궤도 하강 부분이 heal 위치와 정렬되면 catch.
    { x: 820, y: 80, effect: "heal" as const },
  ],
  baseSpeed: 300,
};

const loadout: Loadout = {
  character: coinWalkerChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

describe("플랫폼 위 앞 공중 heal 도약", () => {
  it("봇이 플랫폼 위 heal(y ~ top) 잡기 위해 도약", () => {
    const w = createWorld(1, [stage], loadout);
    let tick = 0;
    while (w.runner.alive && tick < 300) {
      const input = decide(w);
      step(w, input);
      tick++;
      if (w.runner.x > 900) break;
    }
    const collected = w.currentItemCollected[0];
    console.log(`heal(820, 80) 수집=${collected ? "O" : "X"}`);
    expect(collected).toBe(true);
  });
});
