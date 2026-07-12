// 회귀 test — 신규 아이템 효과 coinSpray/coinBoost 기본 동작 검증.
// - coinSpray: 봇 x 이동 50px마다 전방에 코인 3개 소환 (3초).
// - coinBoost: 획득 즉시 currentTrack.items + spawnedItems의 v=1 코인을 v=5로 변환.
//              3초 활성 동안 새로 스폰되는 v=1도 변환.
// - 결정론: 같은 시드에서 두 번 돌린 결과가 완전 동일.

import { describe, expect, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import type { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import type { Stage } from "../src/sim/stage";
import hwangtae from "../src/data/characters/hwangtae.json";
import nurungji from "../src/data/pets/nurungji.json";
import { EMPTY_STAGE } from "../src/sim/stage";

const emptyLoadout: Loadout = {
  character: hwangtae as CharacterSpec,
  pet: nurungji as PetSpec,
  equipment: [] as EquipmentSpec[],
};

// 결정론적 실험용 — 빈 트랙에 봇만 놓고 coinSpray 강제 활성.
function makeEmptyWorld(seed: number) {
  return createWorld(seed, [EMPTY_STAGE], emptyLoadout);
}

describe("coinSpray 트리거 동작", () => {
  it("3초 활성 + 봇 50px 이동마다 3개 소환", () => {
    const w = makeEmptyWorld(42);
    const totalTicks = Math.round(3 / TICK_DURATION);
    w.runner.coinSprayTicks = totalTicks;
    w.runner.coinSpraySpawnAcc = 0;
    const initialSpawned = w.spawnedItems.length;
    for (let t = 0; t < totalTicks; t++) {
      step(w, { jump: false, slide: false });
    }
    const added = w.spawnedItems.length - initialSpawned;
    // step 순서: 타이머 감소(coinSprayTicks-- 먼저) → 트리거 검사. 마지막 tick에는 감소 후 0되어 skip.
    // 실제 활성 tick 수 = totalTicks - 1.
    const activeTicks = totalTicks - 1;
    const dx = w.runner.baseRunSpeed * TICK_DURATION;
    const activeDx = activeTicks * dx;
    const triggers = Math.floor(activeDx / 50);
    const expected = triggers * 3;
    expect(added).toBe(expected);
    expect(w.runner.coinSprayTicks).toBe(0);
  });

  it("소환된 세 코인의 y가 서로 다르고 [0,180] 범위", () => {
    const w = makeEmptyWorld(42);
    w.runner.coinSprayTicks = Math.round(3 / TICK_DURATION);
    w.runner.coinSpraySpawnAcc = 0;
    // 첫 트리거 발생 지점까지 시뮬 (50px 이동 = 봇 속도에 따라 tick 수)
    const ticksToTrigger = Math.ceil(50 / (w.runner.baseRunSpeed * TICK_DURATION));
    const before = w.spawnedItems.length;
    for (let t = 0; t < ticksToTrigger + 1; t++) {
      step(w, { jump: false, slide: false });
    }
    const added = w.spawnedItems.slice(before);
    expect(added.length).toBeGreaterThanOrEqual(3);
    const triple = added.slice(0, 3);
    const ys = triple.map((c) => c.y);
    // 서로 다른 y (같은 값 없음)
    expect(new Set(ys).size).toBe(3);
    // 각 y [0, 180] 범위
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(180);
    }
    // 세 코인 x는 봇 앞 (봇 x보다 큼)
    for (const c of triple) expect(c.x).toBeGreaterThan(w.runner.x);
  });

  it("확률 분포 v1:v5:v25 ≈ 75:20:5 (대량 트리거 통계)", () => {
    const w = makeEmptyWorld(42);
    w.runner.coinSprayTicks = 100000; // 지속시간 무제한처럼
    w.runner.coinSpraySpawnAcc = 0;
    const before = w.spawnedItems.length;
    // 큰 이동으로 많은 트리거 발생
    for (let t = 0; t < 5000; t++) {
      step(w, { jump: false, slide: false });
    }
    const spawned = w.spawnedItems.slice(before);
    const total = spawned.length;
    expect(total).toBeGreaterThan(300); // 최소 표본 확보
    let v1 = 0, v5 = 0, v25 = 0;
    for (const c of spawned) {
      if (c.value === 1) v1++;
      else if (c.value === 5) v5++;
      else if (c.value === 25) v25++;
    }
    // 오차 5%p 허용
    expect(v1 / total).toBeCloseTo(0.75, 1);
    expect(v5 / total).toBeCloseTo(0.2, 1);
    expect(v25 / total).toBeCloseTo(0.05, 1);
  });
});

describe("coinBoost 변환 동작", () => {
  it("획득 즉시 currentTrack.items + spawnedItems의 v=1을 v=5로 변환", () => {
    const w = makeEmptyWorld(42);
    // 인위적으로 items에 v=1, v=5, effect 아이템 추가 (currentTrack이 clone된 상태여야 안전)
    w.currentTrack.items.push({ x: 100, y: 0, value: 1 });
    w.currentTrack.items.push({ x: 200, y: 0, value: 5 });
    w.currentTrack.items.push({ x: 300, y: 0, effect: "heal" });
    w.spawnedItems.push({ x: 500, y: 0, value: 1, collected: false });
    w.spawnedItems.push({ x: 600, y: 0, value: 5, collected: false });
    // coinBoost 획득 시뮬 — 봇 히트박스[봇 x ~ +width, 봇 y ~ +height] 안에 spawn하고 이동으로 수집.
    w.spawnedItems.push({ x: 15, y: 20, effect: "coinBoost", collected: false });
    // 1 tick 진행 → 봇 이동 후 수집
    step(w, { jump: false, slide: false });
    // 정적 items v=1 → 5
    expect(w.currentTrack.items[0]!.value).toBe(5);
    // v=5는 그대로
    expect(w.currentTrack.items[1]!.value).toBe(5);
    // effect 아이템은 손 안 대
    expect(w.currentTrack.items[2]!.effect).toBe("heal");
    expect(w.currentTrack.items[2]!.value).toBeUndefined();
    // spawnedItems v=1 → 5 (아직 수집 안 된 것)
    const remaining = w.spawnedItems.filter((sp) => !sp.collected);
    expect(remaining.find((sp) => sp.x === 500)!.value).toBe(5);
    expect(remaining.find((sp) => sp.x === 600)!.value).toBe(5);
    expect(w.runner.coinBoostTicks).toBeGreaterThan(0);
  });

  it("3초 지속 동안 새로 spawn된 v=1도 v=5로 변환", () => {
    const w = makeEmptyWorld(42);
    w.runner.coinBoostTicks = Math.round(3 / TICK_DURATION);
    // 1 tick 뒤 v=1 spawn
    step(w, { jump: false, slide: false });
    w.spawnedItems.push({ x: w.runner.x + 100, y: 0, value: 1, collected: false });
    // 다음 tick에 boost 로직이 스캔해서 변환
    step(w, { jump: false, slide: false });
    const target = w.spawnedItems[w.spawnedItems.length - 1]!;
    expect(target.value).toBe(5);
  });

  it("원본 stage JSON items는 오염되지 않음 (참조 격리)", () => {
    // 같은 시드로 world 두 개 만들고 첫 world에서 coinBoost 발동 후 두 번째 world의 items 확인.
    const w1 = makeEmptyWorld(42);
    w1.currentTrack.items.push({ x: 100, y: 0, value: 1 });
    w1.spawnedItems.push({ x: 15, y: 20, effect: "coinBoost", collected: false });
    step(w1, { jump: false, slide: false });
    // 두 번째 world — 원본 EMPTY_STAGE.items가 오염되지 않아야 함
    const w2 = makeEmptyWorld(42);
    // w1에서 push한 item이 w2에도 남아있으면 원본 참조 공유 = 오염
    expect(w2.currentTrack.items.length).toBe(0);
  });
});

describe("결정론 확인", () => {
  it("같은 시드 두 번 실행 → coinSpray 스폰 결과 동일", () => {
    function runOnce(): { x: number; y: number; value: number }[] {
      const w = makeEmptyWorld(12345);
      w.runner.coinSprayTicks = Math.round(3 / TICK_DURATION);
      w.runner.coinSpraySpawnAcc = 0;
      for (let t = 0; t < Math.round(3 / TICK_DURATION); t++) {
        step(w, { jump: false, slide: false });
      }
      return w.spawnedItems.map((sp) => ({ x: sp.x, y: sp.y, value: sp.value ?? 0 }));
    }
    const a = runOnce();
    const b = runOnce();
    expect(a).toEqual(b);
  });
});
