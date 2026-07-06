// 봇 거대화 상태에서 공중 heal(y=120) 앞에, 지면 magnet이 flightDist 너머 있을 때
// heal 잡으려 점프해도 magnet은 착지 후 walking으로 잡을 수 있음.
// nearGroundProtect가 flightDist 너머 지면 아이템까지 보호 대상으로 계산하면 heal 놓침.
// 이 fix로 protectGap = min(range, flightDist)로 제한.

import { describe, it, expect } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import coinWalkerChar from "../src/data/characters/coin-walker.json";
import destroyerPet from "../src/data/pets/destroyer.json";

const stage: Stage = {
  id: "test",
  length: 3000,
  obstacles: [],
  items: [
    // 봇 시작 근처 giant 아이템.
    { x: 100, y: 0, effect: "giant" as const },
    // 거대화 후 공중 heal(y=120) — 거대화 몸통 [0,100]으로 못 잡음, 점프 필요.
    { x: 500, y: 120, effect: "heal" as const },
    // heal 지나 magnet — flightDist(204) 너머. 봇 점프 후 착지 walking으로 잡음.
    // 예: bot.x=500 점프 → 착지 704 → walking → magnet.x=750 도달.
    { x: 750, y: 0, effect: "magnet" as const },
  ],
  baseSpeed: 300,
};

const loadout: Loadout = {
  character: coinWalkerChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

describe("거대화 지면 보호가 flightDist 너머 미포함", () => {
  it("봇이 공중 heal 도약 + 착지 후 walking으로 magnet 둘 다 수집", () => {
    const w = createWorld(1, [stage], loadout);
    let tick = 0;
    while (w.runner.alive && tick < 300) {
      const input = decide(w);
      step(w, input);
      tick++;
      if (w.runner.x > 900) break;
    }
    const healCollected = w.currentItemCollected[1];
    const magnetCollected = w.currentItemCollected[2];
    console.log(`heal=${healCollected ? "O" : "X"}, magnet=${magnetCollected ? "O" : "X"}`);
    expect(healCollected).toBe(true);
    expect(magnetCollected).toBe(true);
  });
});
