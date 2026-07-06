import { describe, it, expect } from "vitest";
import { createWorld, step, Input } from "../src/sim/world";
import { Stage } from "../src/sim/stage";
import stage1Data from "../src/data/stages/stage1.json";
import { DEFAULT_LOADOUT } from "./_helpers";

const NO_INPUT: Input = { jump: false, slide: false };
const JUMP: Input = { jump: true, slide: false };

const stage1: Stage = stage1Data as Stage;

describe("장애물 충돌 — 체력 데미지", () => {
  it("장애물에 부딪히면 hp가 30 감소한다", () => {
    const stage: Stage = {
      id: "test",
      length: 1000,
      obstacles: [{ x: 100, width: 40, height: 30 }],
      items: [],
    };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    const initialHp = w.runner.hp;
    // 100/5 = 20틱이면 장애물에 도달
    for (let i = 0; i < 30; i++) step(w, NO_INPUT);
    // 시간 데미지 30/60*5 = 2.5와 충돌 데미지 30을 모두 감안
    expect(w.runner.hp).toBeLessThanOrEqual(initialHp - 30);
    expect(w.runner.alive).toBe(true);
  });

  it("무적시간 동안에는 같은 장애물에서 추가 데미지가 들어오지 않는다", () => {
    const stage: Stage = {
      id: "test",
      length: 1000,
      obstacles: [{ x: 100, width: 200, height: 30 }], // 폭 200 — 캐릭터가 한참 걸쳐있게
      items: [],
    };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    // 첫 충돌까지 진행
    while (w.runner.invincibleTicks === 0) step(w, NO_INPUT);
    const hpAfterFirstHit = w.runner.hp;
    // 무적 동안 추가 30틱 진행해도 hp가 30 더 줄지 않아야 함 (시간 데미지만)
    for (let i = 0; i < 30; i++) step(w, NO_INPUT);
    const hpLost = hpAfterFirstHit - w.runner.hp;
    expect(hpLost).toBeLessThan(30); // 충돌 데미지 30이 또 들어왔으면 30 이상 줄었을 것
  });

  it("체력이 0이 되면 alive=false가 된다", () => {
    const stage: Stage = {
      id: "test",
      length: 100,
      obstacles: [{ x: 50, width: 30, height: 30 }],
      items: [],
    };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    // 100hp를 다 깎으려면 충돌 4번 + 시간 누적. 충분히 길게 돌림.
    for (let i = 0; i < 2000; i++) step(w, NO_INPUT);
    expect(w.runner.alive).toBe(false);
    expect(w.runner.hp).toBe(0);
  });

  it("사망 후에는 step()이 상태를 변경하지 않는다", () => {
    const stage: Stage = {
      id: "test",
      length: 100,
      obstacles: [{ x: 50, width: 30, height: 30 }],
      items: [],
    };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    while (w.runner.alive) step(w, NO_INPUT);
    const snapshot = { x: w.runner.x, tick: w.tick, lap: w.runner.lap };
    step(w, NO_INPUT);
    step(w, NO_INPUT);
    expect(w.runner.x).toBe(snapshot.x);
    expect(w.tick).toBe(snapshot.tick);
    expect(w.runner.lap).toBe(snapshot.lap);
  });
});

describe("시간 데미지", () => {
  it("가만히 시간만 흘러도 hp가 줄어든다 (초당 5)", () => {
    const w = createWorld(1, [{ id: "empty-time", length: 100000, obstacles: [], items: [] }], DEFAULT_LOADOUT);
    const initialHp = w.runner.hp;
    for (let i = 0; i < 60; i++) step(w, NO_INPUT); // 1초
    expect(w.runner.hp).toBeCloseTo(initialHp - 5, 1);
  });
});

describe("아이템 수집", () => {
  it("바닥 아이템 위를 지나가면 자동으로 수집된다", () => {
    const stage: Stage = {
      id: "test",
      length: 1000,
      obstacles: [],
      items: [{ x: 100, y: 0 }],
    };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    for (let i = 0; i < 60; i++) step(w, NO_INPUT);
    expect(w.runner.coins).toBe(1);
    expect(w.currentItemCollected[0]).toBe(true);
  });

  it("점프하지 않으면 공중 아이템은 수집되지 않는다", () => {
    const stage: Stage = {
      id: "test",
      length: 1000,
      obstacles: [],
      items: [{ x: 100, y: 80 }],
    };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    for (let i = 0; i < 60; i++) step(w, NO_INPUT);
    expect(w.runner.coins).toBe(0);
  });

  it("같은 사이클 안에서는 같은 아이템을 중복 수집하지 않는다", () => {
    const stage: Stage = {
      id: "test",
      length: 1000,
      obstacles: [],
      items: [{ x: 50, y: 0 }],
    };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    for (let i = 0; i < 60; i++) step(w, NO_INPUT);
    expect(w.runner.coins).toBe(1);
  });
});

describe("트랙 무한 반복 (wrap)", () => {
  it("스테이지 길이만큼 진행하면 x가 0으로 wrap되고 lap이 증가한다", () => {
    const stage: Stage = { id: "test", length: 100, obstacles: [], items: [] };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    expect(w.runner.lap).toBe(0);
    while (w.runner.lap === 0 && w.runner.alive) step(w, NO_INPUT);
    expect(w.runner.alive).toBe(true);
    expect(w.runner.lap).toBe(1);
    expect(w.runner.x).toBeLessThan(stage.length);
    expect(w.runner.x).toBeGreaterThanOrEqual(0);
  });

  it("wrap이 일어나도 누적 거리는 계속 증가한다", () => {
    const stage: Stage = { id: "test", length: 100, obstacles: [], items: [] };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    while (w.runner.lap === 0) step(w, NO_INPUT);
    expect(w.runner.totalDistance).toBeGreaterThanOrEqual(100);
  });

  it("wrap이 일어나면 아이템이 다시 등장한다 (다시 수집 가능)", () => {
    const stage: Stage = {
      id: "test",
      length: 100,
      obstacles: [],
      items: [{ x: 50, y: 0 }],
    };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    // 첫 사이클에서 수집
    while (w.runner.lap === 0) step(w, NO_INPUT);
    expect(w.runner.coins).toBe(1);
    expect(w.currentItemCollected[0]).toBe(false); // wrap 후 리셋됨

    // 두 번째 사이클에서 또 수집
    while (w.runner.lap === 1) step(w, NO_INPUT);
    expect(w.runner.coins).toBe(2);
  });
});

describe("stage1.json 결정론", () => {
  it("같은 시드 + 같은 입력 수열은 stage1에서도 동일한 결과를 만든다", () => {
    const inputs: Input[] = [];
    for (let i = 0; i < 600; i++) {
      inputs.push(i % 50 === 0 ? JUMP : NO_INPUT);
    }
    const a = createWorld(7, [stage1], DEFAULT_LOADOUT);
    const b = createWorld(7, [stage1], DEFAULT_LOADOUT);
    for (const input of inputs) {
      step(a, input);
      step(b, input);
    }
    expect(a.runner.x).toBe(b.runner.x);
    expect(a.runner.hp).toBe(b.runner.hp);
    expect(a.runner.coins).toBe(b.runner.coins);
    expect(a.runner.alive).toBe(b.runner.alive);
    expect(a.runner.lap).toBe(b.runner.lap);
    expect(a.currentItemCollected).toEqual(b.currentItemCollected);
  });
});
