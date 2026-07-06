// 봇이 거대화 상태에서 y=200에 있는 v=5 코인을 향해 점프해서 잡는지 검증.
// 거대화 몸통 높이 100 + 점프 정점 128 = 최대 y=228 도달 가능.
// 지금까지 봇 판단은 r.baseHeight=50 기준으로 y > 178 코인은 catchableNowPri에
// 반영도 안 됐음 — 실제로는 giant 몸통이 y=228까지 닿는데.

import { describe, it, expect } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import coinWalkerChar from "../src/data/characters/coin-walker.json";
import destroyerPet from "../src/data/pets/destroyer.json";

const testStage: Stage = {
  id: "test",
  length: 5000,
  obstacles: [],
  items: [
    // 봇 스타트 근처에 거대화 아이템
    { x: 105, y: 0, effect: "giant" as const },
    // giant 활성 시점에 접근하는 v=5 코인 — y=200 (giant 몸통 [0,100]엔 못 닿음, 점프 필수)
    { x: 500, y: 200, value: 5 },
    { x: 700, y: 200, value: 5 },
    { x: 900, y: 200, value: 5 },
  ],
  baseSpeed: 300,
};

const loadout: Loadout = {
  character: coinWalkerChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

describe("거대화 + y=200 주황코인 점프 수집 검증", () => {
  it("봇이 거대화 상태로 y=200 v=5 코인을 향해 점프해서 잡음", () => {
    const w = createWorld(1, [testStage], loadout);
    let tick = 0;
    let botJumpedDuringGiant = false;
    const trace: string[] = [];
    while (w.runner.alive && tick < 500) {
      const input = decide(w);
      const r = w.runner;
      if (r.giantTicks > 0 && input.jump) botJumpedDuringGiant = true;
      trace.push(
        `t=${tick.toString().padStart(4)} x=${r.x.toFixed(0).padStart(4)} y=${r.y.toFixed(0).padStart(4)} giant=${r.giantTicks} onG=${r.onGround ? "T" : "F"} jL=${r.jumpsLeft} why=${input.debugReason ?? "?"}`,
      );
      step(w, input);
      tick++;
      if (r.x > 1000) break;
    }
    for (const l of trace) console.log(l);
    const c1 = w.currentItemCollected[1] ?? false;
    const c2 = w.currentItemCollected[2] ?? false;
    const c3 = w.currentItemCollected[3] ?? false;
    console.log(
      `수집: v=5@x=500 y=200: ${c1 ? "O" : "X"}, x=700: ${c2 ? "O" : "X"}, x=900: ${c3 ? "O" : "X"}, giant중 점프=${botJumpedDuringGiant}`,
    );
    // 목표: 봇이 거대화 상태에서 y=200 코인 잡는다
    expect([c1, c2, c3].filter(Boolean).length).toBeGreaterThan(0);
  });
});
