import { describe, it, expect } from "vitest";
import { createWorld, step, Input } from "../src/sim/world";
import { EMPTY_STAGE } from "../src/sim/stage";
import { DEFAULT_LOADOUT } from "./_helpers";

const NO_INPUT: Input = { jump: false, slide: false };
const JUMP: Input = { jump: true, slide: false };

describe("World (시뮬레이션 루프)", () => {
  it("입력 없이 진행하면 캐릭터는 지면에서 수평으로만 이동한다", () => {
    const w = createWorld(1, [EMPTY_STAGE], DEFAULT_LOADOUT);
    for (let i = 0; i < 60; i++) step(w, NO_INPUT);
    expect(w.runner.y).toBe(0);
    expect(w.runner.onGround).toBe(true);
    expect(w.runner.x).toBeGreaterThan(0);
  });

  it("점프 입력 후 캐릭터는 공중에 떴다가 다시 지면으로 돌아온다", () => {
    const w = createWorld(1, [EMPTY_STAGE], DEFAULT_LOADOUT);
    step(w, JUMP);
    expect(w.runner.onGround).toBe(false);
    expect(w.runner.vy).toBeGreaterThan(0);

    for (let i = 0; i < 120; i++) step(w, NO_INPUT);
    expect(w.runner.y).toBe(0);
    expect(w.runner.onGround).toBe(true);
  });

  it("점프 횟수를 모두 사용하면 공중에서 추가 점프가 발동되지 않는다", () => {
    const w = createWorld(1, [EMPTY_STAGE], DEFAULT_LOADOUT);
    // 기본 캐릭터는 maxJumps=2. 두 번 점프하면 jumpsLeft=0이 되어야 함.
    step(w, JUMP);
    step(w, JUMP);
    expect(w.runner.jumpsLeft).toBe(0);
    const vyBefore = w.runner.vy;
    step(w, JUMP); // 세 번째 점프 시도 — 무시되어야 함
    expect(w.runner.vy).toBeLessThan(vyBefore); // 점프 미발동 → 중력만 작용 → vy 감소
  });
});

describe("결정론 (Determinism) 검증", () => {
  it("같은 시드 + 같은 입력 수열은 같은 최종 상태를 만든다", () => {
    const inputs: Input[] = [];
    for (let i = 0; i < 1000; i++) {
      inputs.push(i % 20 === 0 ? JUMP : NO_INPUT);
    }

    const a = createWorld(12345, [EMPTY_STAGE], DEFAULT_LOADOUT);
    const b = createWorld(12345, [EMPTY_STAGE], DEFAULT_LOADOUT);

    for (const input of inputs) {
      step(a, input);
      step(b, input);
    }

    expect(a.runner.x).toBe(b.runner.x);
    expect(a.runner.y).toBe(b.runner.y);
    expect(a.runner.vy).toBe(b.runner.vy);
    expect(a.tick).toBe(b.tick);
  });

  it("같은 시드로 두 번 돌린 난수 수열도 일치한다", () => {
    const a = createWorld(99, [EMPTY_STAGE], DEFAULT_LOADOUT);
    const b = createWorld(99, [EMPTY_STAGE], DEFAULT_LOADOUT);
    for (let i = 0; i < 100; i++) {
      expect(a.rng.next()).toBe(b.rng.next());
    }
  });
});
