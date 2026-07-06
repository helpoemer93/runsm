import { describe, it, expect } from "vitest";
import { createWorld, step, Input } from "../src/sim/world";
import { EMPTY_STAGE, Stage } from "../src/sim/stage";
import { CharacterSpec, Loadout } from "../src/sim/spec";
import { DEFAULT_LOADOUT, DEFAULT_CHARACTER } from "./_helpers";
import coinWalkerCharData from "../src/data/characters/coin-walker.json";

const NO_INPUT: Input = { jump: false, slide: false };

// 빠른 발동 테스트용 변형 — 쿨타임 1초(60틱), 지속 1초(60틱)
const FAST_DASH_CHAR: CharacterSpec = {
  ...DEFAULT_CHARACTER,
  skill: { id: "dash", cooldown: 1, duration: 1 },
};
const FAST_LOADOUT: Loadout = { character: FAST_DASH_CHAR, equipment: [] };

describe("스킬 시스템 — 질주(dash)", () => {
  it("로드아웃에서 스킬을 자동으로 등록한다", () => {
    const w = createWorld(1, [EMPTY_STAGE], DEFAULT_LOADOUT);
    expect(w.skills.length).toBe(1);
    expect(w.skills[0]!.spec.id).toBe("dash");
  });

  it("초기 상태: 비활성 + 쿨타임 카운트다운 중", () => {
    const w = createWorld(1, [EMPTY_STAGE], DEFAULT_LOADOUT);
    expect(w.skills[0]!.activeTicks).toBe(0);
    expect(w.skills[0]!.cooldownTicks).toBe(600); // 10초 × 60틱
  });

  it("쿨타임이 0이 되면 자동 발동된다", () => {
    const w = createWorld(1, [EMPTY_STAGE], FAST_LOADOUT);
    // 60틱 후 쿨다운 0 → 발동
    for (let i = 0; i < 60; i++) step(w, NO_INPUT);
    expect(w.skills[0]!.activeTicks).toBeGreaterThan(0);
    expect(w.skills[0]!.cooldownTicks).toBe(0);
  });

  it("발동 중에는 이동 속도가 2배가 된다", () => {
    const w = createWorld(1, [EMPTY_STAGE], FAST_LOADOUT);
    // 발동 직후 시점까지 진행
    for (let i = 0; i < 60; i++) step(w, NO_INPUT);
    expect(w.skills[0]!.activeTicks).toBeGreaterThan(0);

    // 발동 중인 다음 한 틱의 이동량 = 기본 속도 × 2
    const xBefore = w.runner.x;
    step(w, NO_INPUT);
    const dx = w.runner.x - xBefore;
    expect(dx).toBeCloseTo((w.runner.baseRunSpeed / 60) * 2, 5);
  });

  it("발동 중에는 장애물을 그대로 통과한다", () => {
    const stage: Stage = {
      id: "test",
      length: 1000,
      obstacles: [{ x: 400, width: 40, height: 30 }],
      items: [],
    };
    const w = createWorld(1, [stage], FAST_LOADOUT);
    // 60틱(쿨)+60틱(활성). 활성 중 x = 305 → 895로 진행, 장애물 통과.
    for (let i = 0; i < 100; i++) step(w, NO_INPUT);
    expect(w.runner.alive).toBe(true);
    expect(w.runner.x).toBeGreaterThan(440); // 장애물 끝(x=440) 너머
  });

  it("지속시간이 끝나면 다시 쿨타임으로 돌아간다", () => {
    const w = createWorld(1, [EMPTY_STAGE], FAST_LOADOUT);
    // 60틱(쿨) + 59틱(활성) = 119틱 시점에 활성 1틱 남음
    for (let i = 0; i < 119; i++) step(w, NO_INPUT);
    expect(w.skills[0]!.activeTicks).toBe(1);

    step(w, NO_INPUT); // 120틱: 활성 종료 → 쿨다운 60 재설정
    expect(w.skills[0]!.activeTicks).toBe(0);
    expect(w.skills[0]!.cooldownTicks).toBe(60);
  });

  it("쿨타임이 다시 끝나면 발동이 반복된다", () => {
    const w = createWorld(1, [EMPTY_STAGE], FAST_LOADOUT);
    // 60(쿨) + 60(활성) + 60(쿨) = 180틱 시점에 두 번째 발동
    for (let i = 0; i < 180; i++) step(w, NO_INPUT);
    expect(w.skills[0]!.activeTicks).toBeGreaterThan(0);
  });

  it("비활성 시에는 속도가 원래대로 돌아온다", () => {
    const w = createWorld(1, [EMPTY_STAGE], FAST_LOADOUT);
    // 120틱 후 활성 종료, 쿨다운 페이즈로 진입
    for (let i = 0; i < 120; i++) step(w, NO_INPUT);
    expect(w.skills[0]!.activeTicks).toBe(0);

    // 다음 한 틱의 이동량은 기본 속도와 같아야 함
    const xBefore = w.runner.x;
    step(w, NO_INPUT);
    const dx = w.runner.x - xBefore;
    expect(dx).toBeCloseTo(w.runner.baseRunSpeed / 60, 5);
  });

  it("dash 종료 직후 잔여 무적이 부여된다", () => {
    const w = createWorld(1, [EMPTY_STAGE], FAST_LOADOUT);
    for (let i = 0; i < 119; i++) step(w, NO_INPUT);
    expect(w.skills[0]!.activeTicks).toBe(1);
    expect(w.runner.invincibleTicks).toBe(0);

    step(w, NO_INPUT); // dash 종료 직후
    expect(w.skills[0]!.activeTicks).toBe(0);
    expect(w.runner.invincibleTicks).toBeGreaterThan(0);
  });

  it("결정론: 같은 시드 + 같은 입력 수열은 스킬 상태까지 일치한다", () => {
    const a = createWorld(7, [EMPTY_STAGE], FAST_LOADOUT);
    const b = createWorld(7, [EMPTY_STAGE], FAST_LOADOUT);
    for (let i = 0; i < 300; i++) {
      step(a, NO_INPUT);
      step(b, NO_INPUT);
    }
    expect(a.runner.x).toBe(b.runner.x);
    expect(a.skills[0]!.activeTicks).toBe(b.skills[0]!.activeTicks);
    expect(a.skills[0]!.cooldownTicks).toBe(b.skills[0]!.cooldownTicks);
  });

  it("dash 효과 아이템: dash 스킬 없는 캐릭(coin-walker)이 먹어도 itemDashTicks fallback이 걸린다", () => {
    const coinWalker: CharacterSpec = coinWalkerCharData as CharacterSpec;
    const loadout: Loadout = { character: coinWalker, equipment: [] };
    const stage: Stage = {
      id: "test-dash-item",
      length: 1000,
      obstacles: [],
      items: [{ x: 400, y: 0, effect: "dash" }],
    };
    const w = createWorld(1, [stage], loadout);
    // dash 스킬 없음 확인
    expect(w.skills.length).toBe(0);
    expect(w.runner.itemDashTicks).toBe(0);

    // 아이템 위치까지 진행 — 봇은 자동으로 수집
    while (w.runner.x < 450 && w.runner.alive) step(w, NO_INPUT);

    // itemDashTicks가 fallback 시간(3초=180틱) 근처로 걸려야 함 (1틱 감소 가능)
    expect(w.runner.itemDashTicks).toBeGreaterThan(150);
  });
});
