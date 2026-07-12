// 회귀 test — 신규 장비 3종.
// - 지속의 목걸이 (duration-necklace): 아이템·스킬 지속시간 곱배율
// - 활력의 팔찌 (vitality-bracelet): heal 아이템 회복량 곱배율
// - 질주의 발찌 (swift-anklet): heal 획득 1회당 사이클 이동속도 배율 스택

import { describe, expect, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import type { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { EMPTY_STAGE } from "../src/sim/stage";
import hwangtae from "../src/data/characters/hwangtae.json";
import nurungji from "../src/data/pets/nurungji.json";
import durationNecklace from "../src/data/equipment/duration-necklace.json";
import vitalityBracelet from "../src/data/equipment/vitality-bracelet.json";
import swiftAnklet from "../src/data/equipment/swift-anklet.json";

const noEquipLoadout: Loadout = {
  character: hwangtae as CharacterSpec,
  pet: nurungji as PetSpec,
  equipment: [],
};

function loadoutWith(...eqs: EquipmentSpec[]): Loadout {
  return {
    character: hwangtae as CharacterSpec,
    pet: nurungji as PetSpec,
    equipment: eqs,
  };
}

describe("지속의 목걸이 — 아이템·스킬 지속시간 곱배율", () => {
  it("장비 없을 때 magnet 지속 = 5초 (300 tick)", () => {
    const w = createWorld(1, [EMPTY_STAGE], noEquipLoadout);
    w.spawnedItems.push({ x: 15, y: 20, effect: "magnet", collected: false });
    step(w, { jump: false, slide: false });
    expect(w.runner.magnetTicks).toBe(Math.round(5 / TICK_DURATION));
  });

  it("lv0 지속의 목걸이(×1.1) 착용 시 magnet 지속 = 5.5초 (330 tick)", () => {
    const w = createWorld(
      1,
      [EMPTY_STAGE],
      loadoutWith(durationNecklace as EquipmentSpec),
    );
    w.spawnedItems.push({ x: 15, y: 20, effect: "magnet", collected: false });
    step(w, { jump: false, slide: false });
    expect(w.runner.magnetTicks).toBe(Math.round(5 / TICK_DURATION * 1.1));
  });

  it("지속의 목걸이 2개 착용 시 배율 곱 (×1.21)", () => {
    const w = createWorld(
      1,
      [EMPTY_STAGE],
      loadoutWith(
        durationNecklace as EquipmentSpec,
        durationNecklace as EquipmentSpec,
      ),
    );
    w.spawnedItems.push({ x: 15, y: 20, effect: "giant", collected: false });
    step(w, { jump: false, slide: false });
    expect(w.runner.giantTicks).toBe(
      Math.round((5 / TICK_DURATION) * 1.1 * 1.1),
    );
  });

  it("dash 스킬 자체 지속시간에도 mult 반영", () => {
    const w = createWorld(
      1,
      [EMPTY_STAGE],
      loadoutWith(durationNecklace as EquipmentSpec),
    );
    const dashSkill = w.skills.find((s) => s.spec.id === "dash");
    expect(dashSkill).toBeDefined();
    // hwangtae dash duration = 3초. ×1.1 = 3.3초 → 198 tick
    expect(dashSkill!.durationTotalTicks).toBe(
      Math.round(3 / TICK_DURATION * 1.1),
    );
  });
});

describe("활력의 팔찌 — heal 회복량 곱배율", () => {
  it("장비 없을 때 heal = 10 회복", () => {
    const w = createWorld(1, [EMPTY_STAGE], noEquipLoadout);
    w.runner.hp = 50; // 최대 미만
    w.spawnedItems.push({ x: 15, y: 20, effect: "heal", collected: false });
    step(w, { jump: false, slide: false });
    expect(w.runner.hp).toBeCloseTo(60 - 5 * TICK_DURATION, 3); // -시간데미지
  });

  it("lv0 활력의 팔찌(×1.1) 착용 시 heal = 11 회복", () => {
    const w = createWorld(
      1,
      [EMPTY_STAGE],
      loadoutWith(vitalityBracelet as EquipmentSpec),
    );
    w.runner.hp = 50;
    w.spawnedItems.push({ x: 15, y: 20, effect: "heal", collected: false });
    step(w, { jump: false, slide: false });
    expect(w.runner.hp).toBeCloseTo(61 - 5 * TICK_DURATION, 3);
  });
});

describe("질주의 발찌 — heal 획득 1회당 이동속도 스택", () => {
  it("장비 없을 때 heal 획득해도 이동속도 그대로", () => {
    const w = createWorld(1, [EMPTY_STAGE], noEquipLoadout);
    const baseBonus = w.runner.healSpeedBonusMult;
    w.runner.hp = 50;
    w.spawnedItems.push({ x: 15, y: 20, effect: "heal", collected: false });
    step(w, { jump: false, slide: false });
    expect(w.runner.healSpeedBonusMult).toBe(baseBonus);
  });

  it("lv0 질주의 발찌 1개 착용 시 heal 1회당 +1% (×1.01)", () => {
    const w = createWorld(
      1,
      [EMPTY_STAGE],
      loadoutWith(swiftAnklet as EquipmentSpec),
    );
    w.runner.hp = 50;
    w.spawnedItems.push({ x: 15, y: 20, effect: "heal", collected: false });
    step(w, { jump: false, slide: false });
    expect(w.runner.healSpeedBonusMult).toBeCloseTo(1.01, 4);
  });

  it("질주의 발찌 2개 착용 시 heal 1회당 스택 (+2%)", () => {
    const w = createWorld(
      1,
      [EMPTY_STAGE],
      loadoutWith(swiftAnklet as EquipmentSpec, swiftAnklet as EquipmentSpec),
    );
    w.runner.hp = 50;
    w.spawnedItems.push({ x: 15, y: 20, effect: "heal", collected: false });
    step(w, { jump: false, slide: false });
    expect(w.runner.healSpeedBonusMult).toBeCloseTo(1.02, 4);
  });

  it("heal 여러 번 획득 시 누적 (2회 시 1.02)", () => {
    const w = createWorld(
      1,
      [EMPTY_STAGE],
      loadoutWith(swiftAnklet as EquipmentSpec),
    );
    w.runner.hp = 30;
    w.spawnedItems.push({ x: 15, y: 20, effect: "heal", collected: false });
    step(w, { jump: false, slide: false });
    const after1 = w.runner.healSpeedBonusMult;
    // 봇 진행 후 새 위치에 heal 추가
    w.spawnedItems.push({
      x: w.runner.x + 15,
      y: 20,
      effect: "heal",
      collected: false,
    });
    step(w, { jump: false, slide: false });
    expect(after1).toBeCloseTo(1.01, 4);
    expect(w.runner.healSpeedBonusMult).toBeCloseTo(1.02, 4);
  });

  it("새 사이클(createWorld) 시작 시 healSpeedBonusMult 초기화 (=1)", () => {
    const w = createWorld(
      1,
      [EMPTY_STAGE],
      loadoutWith(swiftAnklet as EquipmentSpec),
    );
    expect(w.runner.healSpeedBonusMult).toBe(1);
  });
});
