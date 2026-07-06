import { describe, it, expect } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { Stage } from "../src/sim/stage";
import { CharacterSpec, EquipmentSpec, Loadout } from "../src/sim/spec";
import stage1Data from "../src/data/stages/stage1.json";
import stage3Data from "../src/data/stages/stage3.json";
import speedShoesData from "../src/data/equipment/shoes.json";
import { DEFAULT_LOADOUT, DEFAULT_CHARACTER } from "./_helpers";

const stage1: Stage = stage1Data as Stage;
const stage3: Stage = stage3Data as Stage;
const speedShoes: EquipmentSpec = speedShoesData as EquipmentSpec;

function runUntil(
  seed: number,
  stage: Stage,
  loadout: Loadout,
  predicate: (w: ReturnType<typeof createWorld>) => boolean,
  maxTicks = 10000,
) {
  const w = createWorld(seed, [stage], loadout);
  let ticks = 0;
  while (!predicate(w) && w.runner.alive && ticks < maxTicks) {
    step(w, decide(w));
    ticks++;
  }
  return w;
}

describe("Bot — 회피 + 수집 + 인지", () => {
  it("stage1을 한 사이클 사망 없이 통과한다 (이단점프 장애물 포함)", () => {
    const w = runUntil(1, stage1, DEFAULT_LOADOUT, (w) => w.runner.lap >= 1);
    expect(w.runner.alive).toBe(true);
    expect(w.runner.lap).toBeGreaterThanOrEqual(1);
  });

  it("정적 트랙 items 시스템 — 봇이 가치 90% 이상 수집", () => {
    // 디자인이 트랙 데이터를 랜덤화한 후에도 Stage.items 시스템 자체는 살아있어야 한다
    // (테스트·향후 정적 미니게임 등 활용 가능). inline fixture로 검증.
    const staticStage: Stage = {
      id: "static-items-test",
      length: 2000,
      obstacles: [
        { x: 400, width: 40, height: 30 },
        { x: 900, width: 40, height: 30 },
        { x: 1400, width: 40, height: 30 },
      ],
      items: [
        { x: 200, y: 0 },
        { x: 340, y: 80 },
        { x: 600, y: 0, effect: "heal" },
        { x: 700, y: 0 },
        { x: 1100, y: 80 },
        { x: 1250, y: 0, value: 5 },
        { x: 1500, y: 80 },
        { x: 1700, y: 0, value: 5 },
      ],
    };
    const w = createWorld(1, [staticStage], DEFAULT_LOADOUT);
    let lastSnapshot = w.currentItemCollected.slice();
    while (w.runner.lap === 0 && w.runner.alive) {
      lastSnapshot = w.currentItemCollected.slice();
      step(w, decide(w));
    }
    const totalValue = staticStage.items.reduce((s, it) => s + (it.value ?? 1), 0);
    const collectedValue = staticStage.items
      .filter((_, i) => lastSnapshot[i])
      .reduce((s, it) => s + (it.value ?? 1), 0);
    expect(collectedValue / totalValue).toBeGreaterThanOrEqual(0.9);
  });

  it("같은 시드에서 봇의 결과는 결정론적이다", () => {
    const a = runUntil(42, stage1, DEFAULT_LOADOUT, (w) => w.runner.lap >= 1);
    const b = runUntil(42, stage1, DEFAULT_LOADOUT, (w) => w.runner.lap >= 1);
    expect(a.runner.coins).toBe(b.runner.coins);
    expect(a.tick).toBe(b.tick);
    expect(a.runner.x).toBe(b.runner.x);
    expect(a.runner.hp).toBe(b.runner.hp);
  });

  it("장애물이 없으면 봇은 점프 없이 통과한다 (회피 우선 검증)", () => {
    const stage: Stage = { id: "test", length: 500, obstacles: [], items: [] };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    let jumpCount = 0;
    while (w.runner.lap === 0 && w.runner.alive) {
      const input = decide(w);
      if (input.jump) jumpCount++;
      step(w, input);
    }
    expect(jumpCount).toBe(0);
  });

  it("공중에 닿지 않는 아이템만 있으면 봇이 점프해서 수집한다", () => {
    const stage: Stage = {
      id: "test",
      length: 500,
      obstacles: [],
      items: [{ x: 200, y: 80 }],
    };
    const w = createWorld(1, [stage], DEFAULT_LOADOUT);
    while (w.runner.lap === 0 && w.runner.alive) step(w, decide(w));
    expect(w.runner.coins).toBe(1);
  });
});

// 스킬 활성 중 봇 동작 — 면역 시 회피 점프는 skip(수집은 그대로)
describe("Bot — dash 활성 중 동작", () => {
  const INSTANT_DASH: CharacterSpec = {
    ...DEFAULT_CHARACTER,
    skill: { id: "dash", cooldown: 1 / 60, duration: 5 },
  };
  const INSTANT_DASH_LOADOUT: Loadout = {
    character: INSTANT_DASH,
    equipment: [],
  };

  it("dash 면역 중에는 ground 장애물 회피 점프를 skip한다 (통과 우선)", () => {
    const stage: Stage = {
      id: "test",
      length: 2000,
      obstacles: [{ x: 200, width: 40, height: 30 }],
      items: [],
    };
    const w = createWorld(1, [stage], INSTANT_DASH_LOADOUT);
    step(w, decide(w));
    expect(w.skills[0]!.activeTicks).toBeGreaterThan(0);

    let jumpCount = 0;
    // dash 활성 동안만 측정 (활성 끝나면 일반 회피 점프 가능)
    for (let i = 0; i < 100 && w.skills[0]!.activeTicks > 0; i++) {
      const input = decide(w);
      if (input.jump) jumpCount++;
      step(w, input);
    }
    expect(jumpCount).toBe(0);
    expect(w.runner.alive).toBe(true);
  });

  it("dash 중에도 공중 아이템 수집은 시도한다", () => {
    const stage: Stage = {
      id: "test",
      length: 2000,
      obstacles: [],
      items: [{ x: 200, y: 80 }],
    };
    const w = createWorld(1, [stage], INSTANT_DASH_LOADOUT);
    while (w.runner.lap === 0 && w.runner.alive) step(w, decide(w));
    expect(w.runner.coins).toBe(1);
  });
});

// 트랙 baseSpeed 환산 — 봇 속도 변해도 obstacle 도달 시간이 일정하게 유지되어
// stage3-slides(ground+슬라이드 좁은 간격) 같은 트랙에서도 회피 가능해야 한다.
describe("Bot — 트랙 환산(baseSpeed) 회귀", () => {
  const SPEED_LOADOUT: Loadout = {
    character: DEFAULT_CHARACTER,
    equipment: [speedShoes, speedShoes, speedShoes],
  };

  it("speed-shoes×3 봇이 stage3-slides 한 사이클을 사망 없이 통과한다", () => {
    const w = createWorld(1, [stage3], SPEED_LOADOUT);
    let collisions = 0;
    while (w.runner.lap === 0 && w.runner.alive) {
      step(w, decide(w));
      if (w.lastCollision !== null) collisions++;
    }
    expect(w.runner.alive).toBe(true);
    expect(w.runner.lap).toBeGreaterThanOrEqual(1);
    // 충돌이 일부 있어도 사망 안 함이 핵심 — 회귀 시 사이클당 다발 충돌 발생.
    expect(collisions).toBeLessThan(5);
  });
});
