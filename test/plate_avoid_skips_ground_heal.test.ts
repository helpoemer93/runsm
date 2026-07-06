// 봇 앞에 플랫폼 회피점프 trigger + 그 사이 지면 heal 있으면 플랫폼 도약 skip.
// 플랫폼은 선택적 발판(안 밟아도 안전) — 지면 보호 대상(heal) 자연 수집 우선.

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
    // 플랫폼 [400, 650], top=80. 봇 회피점프로 올라탈 수 있음.
    { x: 400, width: 250, height: 80, kind: "platform" },
  ],
  items: [
    // heal at (350, 0) — 봇이 플랫폼 회피점프 trigger 진입 시점(gap 80~105)
    // 근처에 있는 지면 heal. 플랫폼 도약 skip해야 봇 걸어가 잡음.
    { x: 350, y: 0, effect: "heal" as const },
  ],
  baseSpeed: 300,
};

const loadout: Loadout = {
  character: defaultChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

describe("플랫폼 회피점프 vs 지면 heal 보호", () => {
  it("봇이 플랫폼 앞 지면 heal 자연 수집 (플랫폼 도약 skip)", () => {
    const w = createWorld(1, [stage], loadout);
    let tick = 0;
    while (w.runner.alive && tick < 300) {
      const input = decide(w);
      step(w, input);
      tick++;
      if (w.runner.x > 800) break;
    }
    const healCollected = w.currentItemCollected[0];
    console.log(`heal(350, 0) 수집=${healCollected ? "O" : "X"}`);
    expect(healCollected).toBe(true);
  });
});
