// 스킬 시스템 — 쿨타임 기반 능동 효과.
// 시작 시 쿨타임 카운트다운 → 0 도달 시 발동 → 지속시간 카운트다운 → 0 도달 시 다시 쿨타임.

import { SkillSpec } from "./spec";

export interface SkillState {
  spec: SkillSpec;
  cooldownTicks: number; // 남은 쿨타임 (틱). 0이고 activeTicks=0이면 곧 발동.
  activeTicks: number; // 남은 지속시간 (틱). >0이면 발동 중.
  cooldownTotalTicks: number; // 발동 후 적용될 총 쿨타임 (틱)
  durationTotalTicks: number; // 발동 시 적용될 총 지속시간 (틱)
}

// 초당 틱 수를 기반으로 SkillSpec을 SkillState로 변환.
export function createSkillState(
  spec: SkillSpec,
  tickDuration: number,
): SkillState {
  const cooldownTotal = Math.round(spec.cooldown / tickDuration);
  const durationTotal = Math.round(spec.duration / tickDuration);
  return {
    spec,
    cooldownTicks: cooldownTotal, // 시작 시 초기 쿨타임을 부여 (즉시 발동 방지)
    activeTicks: 0,
    cooldownTotalTicks: cooldownTotal,
    durationTotalTicks: durationTotal,
  };
}

// 한 틱 진행. 활성 중이면 지속시간 감소, 아니면 쿨타임 감소.
// 0에 도달하면 자동 전환.
export function tickSkill(skill: SkillState): void {
  if (skill.activeTicks > 0) {
    skill.activeTicks--;
    if (skill.activeTicks <= 0) {
      skill.activeTicks = 0;
      skill.cooldownTicks = skill.cooldownTotalTicks;
    }
  } else if (skill.cooldownTicks > 0) {
    skill.cooldownTicks--;
    if (skill.cooldownTicks <= 0) {
      skill.cooldownTicks = 0;
      skill.activeTicks = skill.durationTotalTicks;
    }
  }
}

export function isSkillActive(skill: SkillState): boolean {
  return skill.activeTicks > 0;
}

// 스킬들의 효과를 합쳐서 물리 보정치로 변환.
export interface SkillModifiers {
  speedMultiplier: number; // 수평 속도 배수
  ignoreObstacles: boolean; // true면 장애물 충돌 검사 생략
}

export function aggregateSkillModifiers(skills: SkillState[]): SkillModifiers {
  let speedMultiplier = 1;
  let ignoreObstacles = false;
  for (const s of skills) {
    if (!isSkillActive(s)) continue;
    switch (s.spec.id) {
      case "dash":
        speedMultiplier *= 2;
        ignoreObstacles = true;
        break;
      // 새 스킬 추가 시 여기에 케이스 추가
    }
  }
  return { speedMultiplier, ignoreObstacles };
}
