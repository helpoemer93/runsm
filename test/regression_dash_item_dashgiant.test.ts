// 회귀 test — dashGiant 특성 캐릭(황태) + dash 스킬 조합에서 dash 아이템 획득 시
// giant 활성이 안 되던 버그 fix 회귀 방지.
//
// 이전 로직: applyItemEffect(dash) branch가 dashSkill.activeTicks만 세팅. handleSkillActivation
// 경로에 의존했지만 step()의 트랜지션 감지는 아이템 수집보다 앞에 실행 → dash 아이템으로
// 강제 활성해도 dashGiant 안 켜짐.
// fix: applyItemEffect(dash) branch에서 activateDashGiantIfApplicable 직접 호출.

import { describe, expect, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
import type { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { EMPTY_STAGE } from "../src/sim/stage";
import hwangtae from "../src/data/characters/hwangtae.json";
import nurungji from "../src/data/pets/nurungji.json";

const loadout: Loadout = {
  character: hwangtae as CharacterSpec,
  pet: nurungji as PetSpec,
  equipment: [],
};

describe("dashGiant 특성 + dash 아이템 획득 시 giant 활성", () => {
  it("사이클 시작 직후(dash 스킬 cooldown 중) dash 아이템 획득하면 giantTicks > 0", () => {
    const w = createWorld(1, [EMPTY_STAGE], loadout);
    // 초기 상태 확인 — giant 꺼짐, dash 스킬 cooldown 중
    expect(w.runner.giantTicks).toBe(0);
    const dashSkill = w.skills.find((s) => s.spec.id === "dash")!;
    expect(dashSkill.activeTicks).toBe(0);
    expect(dashSkill.cooldownTicks).toBeGreaterThan(0);
    // dash 아이템을 봇 앞에 놓고 1 tick 진행 → 봇이 수집
    w.spawnedItems.push({ x: 15, y: 20, effect: "dash", collected: false });
    step(w, { jump: false, slide: false });
    // dashGiant 특성 발동 확인
    expect(w.runner.giantTicks).toBeGreaterThan(0);
    // dash 스킬도 활성
    expect(dashSkill.activeTicks).toBeGreaterThan(0);
  });

  it("dash 스킬이 이미 활성인 상태에서 dash 아이템 획득 시 giant 지속시간 재세팅", () => {
    const w = createWorld(1, [EMPTY_STAGE], loadout);
    const dashSkill = w.skills.find((s) => s.spec.id === "dash")!;
    // dash 스킬 강제 활성
    dashSkill.activeTicks = 30;
    dashSkill.cooldownTicks = 0;
    w.runner.giantTicks = 30; // 이전 발동 잔여
    // dash 아이템 획득
    w.spawnedItems.push({ x: 15, y: 20, effect: "dash", collected: false });
    step(w, { jump: false, slide: false });
    // giantTicks가 새 duration만큼 갱신됨 (30보다 훨씬 크게)
    expect(w.runner.giantTicks).toBeGreaterThan(30);
  });
});
