import { describe, it, expect } from "vitest";
import { createWorld, step, Input } from "../src/sim/world";
import { EMPTY_STAGE, Stage } from "../src/sim/stage";
import { CharacterSpec, Loadout } from "../src/sim/spec";
import { DEFAULT_LOADOUT, DEFAULT_CHARACTER } from "./_helpers";

const NO_INPUT: Input = { jump: false, slide: false };
const JUMP: Input = { jump: true, slide: false };

const SINGLE_JUMP_CHAR: CharacterSpec = {
  ...DEFAULT_CHARACTER,
  maxJumps: 1, // 이단점프 불가
};
const SINGLE_JUMP_LOADOUT: Loadout = {
  character: SINGLE_JUMP_CHAR,
  equipment: [],
};

describe("이단점프", () => {
  it("공중에서 두 번째 점프가 가능하다 (vy가 jumpVelocity로 재설정)", () => {
    // 비교용 두 시뮬 — A는 이단점프, B는 첫 점프 후 가만히
    const a = createWorld(1, [EMPTY_STAGE], DEFAULT_LOADOUT);
    const b = createWorld(1, [EMPTY_STAGE], DEFAULT_LOADOUT);
    expect(a.runner.jumpsLeft).toBe(2);

    step(a, JUMP);
    step(b, JUMP);
    expect(a.runner.jumpsLeft).toBe(1);

    step(a, JUMP); // 이단점프
    step(b, NO_INPUT); // 가만히 떨어지는 중

    expect(a.runner.jumpsLeft).toBe(0);
    // 이단점프한 A의 vy는 중력만 받은 B의 vy보다 커야 함 (점프로 vy 재설정됨)
    expect(a.runner.vy).toBeGreaterThan(b.runner.vy);
  });

  it("이단점프 후 세 번째 점프 시도는 무시된다", () => {
    const w = createWorld(1, [EMPTY_STAGE], DEFAULT_LOADOUT);
    step(w, JUMP);
    step(w, JUMP); // 이단점프
    expect(w.runner.jumpsLeft).toBe(0);

    const vyBefore = w.runner.vy;
    step(w, JUMP); // 무시되어야 함
    expect(w.runner.vy).toBeLessThan(vyBefore); // 중력만 작용
  });

  it("착지하면 점프 횟수가 리셋된다", () => {
    const w = createWorld(1, [EMPTY_STAGE], DEFAULT_LOADOUT);
    step(w, JUMP);
    step(w, JUMP);
    expect(w.runner.jumpsLeft).toBe(0);

    // 충분히 시간 보내서 착지
    for (let i = 0; i < 150; i++) step(w, NO_INPUT);
    expect(w.runner.onGround).toBe(true);
    expect(w.runner.jumpsLeft).toBe(2);
  });

  it("maxJumps=1 캐릭터는 공중 점프가 불가능하다", () => {
    const w = createWorld(1, [EMPTY_STAGE], SINGLE_JUMP_LOADOUT);
    expect(w.runner.maxJumps).toBe(1);
    step(w, JUMP);
    expect(w.runner.jumpsLeft).toBe(0);

    const vyBefore = w.runner.vy;
    step(w, JUMP); // 공중 두 번째 점프 — 무시
    expect(w.runner.vy).toBeLessThan(vyBefore);
  });

});
