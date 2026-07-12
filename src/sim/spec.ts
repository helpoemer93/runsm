// 캐릭터/펫/장비 사양 정의 — JSON으로 정의되어 코드 수정 없이 추가/조정 가능.

export interface SkillSpec {
  id: string; // 스킬 효과 식별자 (예: "dash")
  cooldown: number; // 쿨타임 (초)
  duration: number; // 지속시간 (초)
}

export interface CharacterSpec {
  id: string;
  name: string;
  runSpeed: number; // 픽셀/초
  jumpVelocity: number; // 픽셀/초 (점프 시 초기 수직 속도)
  width: number; // 캐릭터 가로 크기
  height: number; // 캐릭터 세로 크기 (기본 자세)
  maxHp: number; // 최대 체력
  maxJumps: number; // 최대 점프 횟수 (1=단일점프, 2=이단점프)
  slideHeight?: number; // 슬라이드 중 hitbox 높이 (생략 시 height/2)
  skill?: SkillSpec; // 능동 스킬 (없을 수도 있음)
  // 패시브 — 봇이 이 거리(px)만큼 이동할 때마다 코인 1개 자동 획득.
  // 생략 시 효과 없음. 트랙 환산이 봇 baseRunSpeed에 비례하므로
  // 단위 시간당 발동 횟수는 봇 속도와 무관(거리 단위로 균등).
  coinPerDistance?: number;
  // 스프라이트 세트 id. 생략 시 캐릭터 id를 그대로 사용.
  // 렌더 코드가 이 값을 키로 스프라이트 세트를 조회.
  spriteId?: string;
  // 대시가 활성화되는 순간(스킬 자체 발동·아이템 dash·회복부적 healDash 어느 경로든)
  // 거대화(giant)도 동일 지속시간만큼 함께 활성. 기존 giantTicks가 더 길면 그쪽 유지.
  dashGiant?: boolean;
}

export interface PetSpec {
  id: string;
  name: string;
  skill?: SkillSpec;
  // 로비 UI에서 표시할 자연어 설명. 생략 시 기본 표기(스킬 id) 사용.
  description?: string;
}

// 장비는 곱셈 보정치만 우선 지원. 미정의 항목은 1.0(보정 없음)으로 간주.
export interface EquipmentSpec {
  id: string;
  name: string;
  runSpeedMult?: number;
  jumpVelocityMult?: number;
  // 회복 아이템 획득 시 dash 효과 발동 시간(초). 같은/다른 장비에 있어도 모두 합산됨.
  healDashSeconds?: number;
  // 결과창에서 누적 코인에 곱해질 배율 (시뮬에는 영향 없음).
  coinValueMult?: number;
  // 지속시간 있는 아이템(magnet/giant/dash/coinSpray/coinBoost/healDash) + dash 스킬 자체
  // 지속시간에 곱해질 배율. 여러 장비에 있으면 모두 곱해짐.
  itemDurationMult?: number;
  // heal 아이템 회복량에 곱해질 배율. 여러 장비에 있으면 모두 곱해짐.
  healAmountMult?: number;
  // heal 아이템 획득 1회마다 사이클 동안 이동속도 배율에 더해지는 값 (0.01=+1%).
  // 여러 장비에 있으면 heal 1회당 각각 스택(합산 후 누적).
  healSpeedBoostPct?: number;
  // 강화 1레벨당 각 필드에 더해질 증분. 신발이라면 { runSpeedMult: 0.01 }.
  enhanceDelta?: {
    runSpeedMult?: number;
    jumpVelocityMult?: number;
    healDashSeconds?: number;
    coinValueMult?: number;
    itemDurationMult?: number;
    healAmountMult?: number;
    healSpeedBoostPct?: number;
  };
}

export interface Loadout {
  character: CharacterSpec;
  pet?: PetSpec;
  equipment: EquipmentSpec[];
}

// 모든 장비 보정치를 누적해 캐릭터 기본 스탯에 적용한 결과를 계산한다.
export function effectiveStats(loadout: Loadout) {
  const c = loadout.character;
  let runSpeedMult = 1;
  let jumpVelocityMult = 1;
  let itemDurationMult = 1;
  let healAmountMult = 1;
  let healSpeedBoostPct = 0;
  for (const e of loadout.equipment) {
    runSpeedMult *= e.runSpeedMult ?? 1;
    jumpVelocityMult *= e.jumpVelocityMult ?? 1;
    itemDurationMult *= e.itemDurationMult ?? 1;
    healAmountMult *= e.healAmountMult ?? 1;
    healSpeedBoostPct += e.healSpeedBoostPct ?? 0;
  }
  return {
    runSpeed: c.runSpeed * runSpeedMult,
    jumpVelocity: c.jumpVelocity * jumpVelocityMult,
    width: c.width,
    height: c.height,
    itemDurationMult,
    healAmountMult,
    healSpeedBoostPct,
  };
}
