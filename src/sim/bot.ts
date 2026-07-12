import { World, Input, isObstacleImmune, TICK_DURATION } from "./world";
import { Item, ItemEffect, Obstacle, Pit } from "./stage";
import { aggregateSkillModifiers } from "./skill";
import { bestDoubleJumpTiming } from "./scorer";

// 회피점프를 skip해야 하는 "지속 효과 면역"만 추림.
// invincibleTicks(잔여 무적·충돌 무적)는 곧 끝나므로 점프는 활성화 — 끝난 시점에
// 장애물 코앞이면 회피 트리거를 놓쳐 충돌함. 잔여 무적 동안 미리 점프해두는 게 안전.
function isLastingImmune(world: World): boolean {
  const mods = aggregateSkillModifiers(world.skills);
  return (
    mods.ignoreObstacles ||
    world.runner.giantTicks > 0 ||
    world.runner.itemDashTicks > 0
  );
}

const GRAVITY_ABS = 2200; // world.ts의 GRAVITY 절댓값과 동기화 필요
const GIANT_SCALE = 2; // world.ts의 GIANT_SCALE와 동기화 — 거대화 시 몸통 배율

// 봇이 점프해서 아이템을 잡을 때 실제 몸통 높이.
// 거대화 활성 시 baseHeight × GIANT_SCALE — 몸통이 커진 상태로 점프하므로
// 실제 도달 y는 정점 + jumpBodyHeight까지. 봇 판단은 이걸 써야 실제 몸통과 일치.
// 슬라이드 상태로 잘못 축소된 r.height는 반영 안 함 — 점프 결정 시엔 몸통이
// 곧 baseHeight로 복귀하는 게 정상 흐름.
function jumpBodyHeight(world: World): number {
  const r = world.runner;
  return r.giantTicks > 0 ? r.baseHeight * GIANT_SCALE : r.baseHeight;
}

// 봇 시야에 들어오는 장애물 — currentTrack의 살아있는 obstacle + nextTrack obstacle을
// currentTrack 좌표계 절대 x로 합쳐 반환. 트랙 이음새 근처(예: 봇이 트랙 끝 플랫폼에서
// walkoff 하강 상태로 새 트랙 x=0 진입)에서도 새 트랙 첫 장애물을 사전 인지해
// 회피 트리거 여유를 확보. nextTrack.obstacles는 파괴 상태 없음(트랙 wrap 시 새로 배정).
function visibleObstacles(world: World): Obstacle[] {
  const cur = world.currentTrack.obstacles;
  const result: Obstacle[] = [];
  for (let i = 0; i < cur.length; i++) {
    if (world.destroyedObstacles[i]) continue;
    result.push(cur[i]!);
  }
  const offset = world.currentTrack.length;
  for (const o of world.nextTrack.obstacles) {
    result.push({ ...o, x: o.x + offset });
  }
  return result;
}

// 회피점프·구멍 회피 발동 직전 지연 판정.
// 봇 앞 (botFrontX, targetX - minReserve] 사이에 지면 아이템이 있으면 true —
// 회피를 몇 tick 미루면 봇이 걸어가 자연 수집 가능하고, 그 시점에도 targetX까지
// minReserve만큼 여유가 남아 회피 재발동에 지장 없음.
// 지면 아이템 = y ≤ baseHeight (봇이 지면 상태로 몸통 사각형에 걸리는 y 범위).
// 봇 앞 (botFrontX, targetX) 사이 지면 아이템 중 가장 뒤(target에 가장 가까운) x 리턴.
// 없으면 -Infinity. 호출자가 지연 후 회피 안전 여부 판정 시 사용.
function lastGroundItemXBefore(
  world: World,
  botFrontX: number,
  targetX: number,
): number {
  const baseH = world.runner.baseHeight;
  const isGroundY = (y: number) => y >= 0 && y <= baseH;
  let lastX = -Infinity;
  for (let i = 0; i < world.currentTrack.items.length; i++) {
    if (world.currentItemCollected[i]) continue;
    const it = world.currentTrack.items[i]!;
    if (!isGroundY(it.y)) continue;
    if (it.x > botFrontX && it.x < targetX && it.x > lastX) lastX = it.x;
  }
  for (const sp of world.spawnedItems) {
    if (sp.collected) continue;
    if (!isGroundY(sp.y)) continue;
    if (sp.x > botFrontX && sp.x < targetX && sp.x > lastX) lastX = sp.x;
  }
  return lastX;
}

// 회피점프·구멍 회피 지연 판정 — 봇 앞 (botFrontX, targetX) 사이 지면 아이템 중
// 가장 뒤(target에 가장 가까운) x 기준으로 지연 후 target까지 남는 gap이 minReserve
// 이상이면 지연 안전 (true 반환). 여러 아이템 chain으로 회피 zone 이탈하던 문제 방지.
// 케이스: 시드 825567814 신발×3 lv20 t=751 봇 x=8249.7 obstacle x=8432.7,
//   지면 (8294,0) v=5 + (8344,0) v=1. 원 로직 → 지연 chain → 옆면 충돌.
//   새 로직: 마지막 (8344,0) 통과 후 gap 58.7 < minReserve 65.9 → 지연 skip → 회피 즉시 발동.
function hasGroundItemBefore(
  world: World,
  botFrontX: number,
  targetX: number,
  minReserve: number,
): boolean {
  const lastX = lastGroundItemXBefore(world, botFrontX, targetX);
  if (lastX === -Infinity) return false;
  const baseW = world.runner.baseWidth;
  // 마지막 아이템 통과 시점 봇 우측 = lastX + baseW. 그 시점 target까지 gap.
  const gapAfterCollect = targetX - (lastX + baseW);
  return gapAfterCollect >= minReserve;
}

function visiblePits(world: World): Pit[] {
  const cur = world.currentTrack.pits ?? [];
  const next = world.nextTrack.pits ?? [];
  if (next.length === 0) return cur;
  const offset = world.currentTrack.length;
  const result: Pit[] = [];
  for (const p of cur) result.push(p);
  for (const p of next) result.push({ ...p, x: p.x + offset });
  return result;
}

// 아이템 우선순위 — 자석은 250px 범위 미수집 흡수로 회복보다 잠재 가치 큼.
function itemPriority(item: Item): number {
  if (item.effect === "magnet") return 1500;
  if (item.effect === "heal") return 1000;
  if (item.effect) return 100;
  return item.value ?? 1;
}

// 회피·슬라이드 트리거 거리는 "obstacle 도달까지 남은 시간(초)" 단위로 정의.
// 매 결정마다 현재 effective 속도와 곱해 픽셀 거리로 변환 — 장비 runSpeedMult,
// dash buff 등 모든 속도 변화에 자동 따라감(같은 도달 시간에 트리거).
// 기존 픽셀 상수(300px/s 기본 속도 기준)와 동일한 값으로 환산.
const AVOID_LOW_TRIGGER_MIN_SEC = 20 / 300;
const AVOID_LOW_TRIGGER_MAX_SEC = 70 / 300;
// high obstacle은 단점프만으론 못 넘어 이단점프 보충 필요. 봇 단점프 정점이 obstacle 좌측에
// 정렬되어야 정점에서 이단점프 보충해서 안전 통과 가능 — 단점프 정점 시간(0.35s) × baseSpeed가
// 적정 gap이라는 뜻. 시간 단위 trigger라 baseSpeed 무관하게 trajectory 동일 (봇 정점 y=122.5).
// MAX > 0.35s면 봇 정점 후 obstacle 진입 → 봇 발 이미 떨어진 상태에서 보충 → 우측 통과 시
// 못 넘김 (시드 1926305692 사례). 그래서 MAX는 0.35s 이하.
// MIN을 너무 작게 잡으면 봇이 obstacle 직전 점프 → 정점 전 obstacle 진입 → 정점 부근 분기로
// 처리 가능 (line 475).
const AVOID_HIGH_TRIGGER_MIN_SEC = 80 / 300;
// MAX 105는 봇 정점이 벽 앞 27px에 위치 → 정점 후 벽 진입 시 이미 하강 시작해 y 부족.
// MAX 130으로 상향 시 봇이 벽 앞 52px 지점부터 발동 가능 → 정점에서 이단점프 보충하면
// 새 flight로 벽 안전 통과. H 옆면 사망 케이스(6건) 대응.
const AVOID_HIGH_TRIGGER_MAX_SEC = 130 / 300;
const DOUBLE_JUMP_TRIGGER_MIN_SEC = 0;
const DOUBLE_JUMP_TRIGGER_MAX_SEC = 50 / 300;
const SLIDE_TRIGGER_LOOKAHEAD_SEC = 80 / 300;
const SLIDE_TRIGGER_TAIL_SEC = 10 / 300;
// pit 회피 트리거 거리 — 초 단위로 정의해서 봇 속도(dash 포함) 변화에 자동 비례.
// 기존 60px @ baseSpeed 300 = 0.2s. 봇이 빠를수록 더 이른 시점 발동 → 반응 여유 일관.
// (확장 시도 100/300, 200/300 모두 오히려 pit 사망 증가 → 60/300 유지가 최적)
const PIT_TRIGGER_LOOKAHEAD_SEC = 60 / 300;
// pit 착지 안전 마진 — 시간 단위. 기존 30px @ baseSpeed 300 = 0.1s.
// 봇 baseSpeed 환산 원칙 준수: 봇 속도 빨라져도 도달 시간 기준 여유 일관.
// 구멍 안전 여유 — 봇 착지 예측이 구멍 우측 끝에서 이 값 이상 넘어가야 회피 발동.
// 30이었으나 실제 오차 대비 과도해서 회피 skip → 사망 유발 케이스 다수 (특히 dash 곧 활성 상황).
// 15로 완화 — 봇 실제 이동은 dash 유지 시 더 크므로 아슬아슬해도 안전 통과 가능성 높음.
const PIT_SAFETY_MARGIN_SEC = 15 / 300;
// 보호 거리는 단점프 비행 거리(약 210px) / dash 비행 거리(약 420px) 약간 너머까지.
const GROUND_PROTECT_RANGE_SEC = 260 / 300;
const GROUND_PROTECT_RANGE_IMMUNE_SEC = 500 / 300;

// 수집점프 트리거 zone (시간 단위) — 봇 이동 속도에 비례해서 픽셀 거리 결정.
// baseSpeed 300 기준 20~70픽셀 = 0.067s~0.233s. 신발×3(400)은 27~93픽셀로 확장 →
// 결정 여유 시간이 봇 속도와 무관하게 일정 유지 (다른 트리거들과 일관).
const JUMP_TRIGGER_MIN_SEC = 20 / 300;
const JUMP_TRIGGER_MAX_SEC = 70 / 300;

// 단점프로 회피 가능한 obstacle 최대 높이 = 정점 - 안전 마진.
// jumpVelocity 변화(점프부적 등) 자동 반영.
const SINGLE_JUMP_SAFETY_MARGIN = 22.5;
function singleJumpHeightLimit(world: World): number {
  const jV = world.runner.jumpVelocity;
  return (jV * jV) / (2 * GRAVITY_ABS) - SINGLE_JUMP_SAFETY_MARGIN;
}

// 비행 중 이단점프 발동 시 봇 궤도로 low ground obstacle 안전 통과 가능한지.
// Case A: 이산 시뮬(step별)로 obstacle x 범위 통과 중 봇 발 y >= obstacle top (위로 통과).
// Case B: 봇 착지가 obstacle 앞이고 walking gap ≥ avoid_low trigger MIN (착지 후 회피점프 가능).
// Case A는 이산 시뮬 필수 — 연속식은 borderline 몇 px 오차로 통과 판정 후 실제 충돌
// (BugReport #4: seed 1179522360 tick 341 heal 수집 이단점프 후 obstacle(h=30) 옆면 충돌.
//  연속식 yMin=34.5 vs 실제 이산 시뮬 y가 30 아래).
// obstacle 높이가 low(highHeightLimit 이하)임을 호출측에서 사전 판정한 뒤 호출.
function doubleJumpClearsLowObs(
  world: World,
  oX: number,
  oWidth: number,
  oHeight: number,
  effSpeed: number,
): boolean {
  const r = world.runner;
  const jv = r.jumpVelocity;
  const g = GRAVITY_ABS;
  const dt = TICK_DURATION;
  const advancePerStep = effSpeed * dt;
  if (advancePerStep <= 0) return false;
  // Case A: 이산 시뮬 — obstacle 통과 중 봇 발 y가 항상 obstacle top 이상.
  {
    let y = r.y;
    let vy = jv;
    let x = r.x;
    const oRight = oX + oWidth;
    for (let s = 0; s < 200; s++) {
      vy -= g * dt;
      y += vy * dt;
      x += advancePerStep;
      if (y < 0) break; // 착지 — Case B로.
      const botRight = x + r.baseWidth;
      if (botRight > oX && x < oRight) {
        if (y < oHeight) break; // 옆면 충돌 예상 → Case B로.
      }
      if (x >= oRight) return true; // obstacle 우측 지남 — 안전.
    }
  }
  // Case B: 봇 착지가 obstacle 앞, 착지 후 walking gap이 avoid_low trigger MIN 이상.
  const tLand = (jv + Math.sqrt(jv * jv + 2 * g * r.y)) / g;
  const landRight = r.x + effSpeed * tLand + r.baseWidth;
  if (landRight < oX) {
    const gapAfterLand = oX - landRight;
    if (gapAfterLand >= AVOID_LOW_TRIGGER_MIN_SEC * effSpeed) return true;
  }
  return false;
}

// 현재 봇의 effective 달리기 속도 (px/s).
// 캐릭터 기본 속도 × 장비 runSpeedMult는 이미 baseRunSpeed에 반영되어 있고,
// 그 위에 dash·itemDash 같은 일시 가속 buff까지 곱한 실측 속도.
function currentEffectiveSpeed(world: World): number {
  const mods = aggregateSkillModifiers(world.skills);
  let mult = mods.speedMultiplier;
  if (world.runner.itemDashTicks > 0) mult = Math.max(mult, 2);
  return world.runner.baseRunSpeed * mult;
}

// "비행 중 잃기 아까운" ground 아이템 — 모든 효과(heal/magnet/dash/giant) + v≥5 코인.
// 일반 코인(v=1)은 잃어도 가치 작아 보호 안 함.
function isProtectedItem(item: {
  value?: number;
  effect?: import("./stage").ItemEffect;
}): boolean {
  if (item.effect) return true;
  return (item.value ?? 1) >= 5;
}

// 앞쪽 가까이에 통과로 잡아야 할 ground 아이템이 있는지 검사
// (정적 트랙 아이템 + 펫·random drop으로 spawn된 동적 아이템).
// 단, 같은 범위 안에 단점프로 닿을 가치 있는 공중 아이템(effect 또는 v≥5)이
// 있으면 점프 우선이라 보호 해제 — 그 점프로 같이 잡힐 수도, 미스해도 의미 큼.
function nearGroundProtect(world: World, range: number): boolean {
  const r = world.runner;
  // 거대화 시 몸통이 커져 정점에서 도달 y도 더 높음 — jumpBodyHeight 반영.
  const jbH = jumpBodyHeight(world);
  const singleJumpReach =
    (r.jumpVelocity * r.jumpVelocity) / (2 * GRAVITY_ABS) + jbH;

  // 봇 앞 회피 zone 안 낮은 obstacle 있으면 보호 해제 — 회피 우선.
  // 원 로직은 봇 앞 지면 heal/v≥5 잡으려 walking 유지. 하지만 회피 zone 안 obstacle
  //   있으면 지연으로 옆면 30 데미지 감수 위험 → 아이템 이득보다 손해 큼. 회피 발동 우선.
  // 케이스: 신발×3 lv20 시드 1175943786 t=1087 봇 앞 obstacle(gap 154, avoid zone 진입)
  //   + 지면 v=5 → 원 로직 walking 유지 → 옆면 충돌 사망. 회피 우선하면 안전 통과.
  const effSpeed = currentEffectiveSpeed(world);
  const avoidLowMin = AVOID_LOW_TRIGGER_MIN_SEC * effSpeed;
  const avoidLowMax = AVOID_LOW_TRIGGER_MAX_SEC * effSpeed;
  const avoidHighMin = AVOID_HIGH_TRIGGER_MIN_SEC * effSpeed;
  const avoidHighMax = AVOID_HIGH_TRIGGER_MAX_SEC * effSpeed;
  const gapMargin = 0.5 * effSpeed * TICK_DURATION;
  const highHeightLimit = singleJumpHeightLimit(world);
  const visibleObs = visibleObstacles(world);
  for (const o of visibleObs) {
    if ((o.yBottom ?? 0) > 0) continue; // 천장은 슬라이드 영역, 회피점프 대상 X
    if (o.kind === "platform") continue;
    const gap = o.x - (r.x + r.width);
    const isHigh = o.height > highHeightLimit;
    const min = isHigh ? avoidHighMin : avoidLowMin;
    const max = isHigh ? avoidHighMax : avoidLowMax;
    if (gap >= min - gapMargin && gap <= max + gapMargin) {
      return false;
    }
  }

  // 봇 활성 중 effect는 중복 발동 가치 작음(시간 max 갱신만) → priority 0으로 취급.
  // 케이스: seed 1189635507 dash 활성 중 dash 잡으러 점프해서 ground heal 미스.
  const dashSkillActive = world.skills.some(
    (s) => s.activeTicks > 0 && s.spec.id === "dash",
  );
  const effectivePri = (item: { value?: number; effect?: import("./stage").ItemEffect }): number => {
    if (item.effect === "magnet" && r.magnetTicks > 0) return 0;
    if (item.effect === "giant" && r.giantTicks > 0) return 0;
    if (item.effect === "dash" && (r.itemDashTicks > 0 || dashSkillActive)) return 0;
    return itemPriority(item as Item);
  };

  // 2단계 먼저: ground 보호 대상(봇 걸어가면 몸통에 걸리는 y ≤ jbH 아이템) 중
  // 가장 큰 priority. 0이면 보호 대상 없음 → 점프 무관.
  // 봇 점프 시 flight arc(bot.y>0)가 지면 item(y=0) 몸통 못 겹침 → gap [0, flightDist]
  // 구간 지면 item만 실제 손실 위험. flightDist 너머 item은 착지 후 walking으로 잡음.
  // range는 전체 감지 범위, protection 위험 판정은 flightDist 이내로 좁힘.
  const flightTimeGround = (2 * r.jumpVelocity) / GRAVITY_ABS;
  const flightDistGround = currentEffectiveSpeed(world) * flightTimeGround;
  const protectGap = Math.min(range, flightDistGround);
  let groundProtectPri = 0;
  // 봇 자연 수집 대상 = 봇 몸통 [r.y, r.y+jbH] 안 아이템. 봇 실제 y 반영(플랫폼 위 상황 대응).
  // 케이스: seed 1032013380 플랫폼 위 r.y=80 상태에서 c5(y=80)이 봇 몸통 안이라 자연 수집인데
  //   기존 `item.y > jbH` 필터는 r.y=0 가정이라 c5를 보호 대상에서 제외 → 앞의 c1(y=180)
  //   잡으려 수집점프 발동 → 봇 y=200 이상 튕겨 c5·뒤쪽 heal 놓침.
  for (let i = 0; i < world.currentTrack.items.length; i++) {
    if (world.currentItemCollected[i]) continue;
    const item = world.currentTrack.items[i]!;
    if (item.y < r.y || item.y > r.y + jbH) continue;
    if (!isProtectedItem(item)) continue;
    const gap = item.x - r.x;
    if (gap >= -r.baseWidth && gap <= protectGap) {
      const pri = effectivePri(item);
      if (pri > groundProtectPri) groundProtectPri = pri;
    }
  }
  for (const sp of world.spawnedItems) {
    if (sp.collected) continue;
    if (sp.y < r.y || sp.y > r.y + jbH) continue;
    if (!isProtectedItem(sp)) continue;
    const gap = sp.x - r.x;
    if (gap >= -r.baseWidth && gap <= protectGap) {
      const pri = effectivePri(sp);
      if (pri > groundProtectPri) groundProtectPri = pri;
    }
  }
  if (groundProtectPri === 0) return false;

  // 1단계: 공중 catchable priority "합" > 지면 보호 대상 pri × K 이면 해제.
  // - 단점프 도달 가능 (y ∈ (jbH, singleJumpReach]) 공중 아이템 (effect + 코인 v≥5)
  // - 이단점프 콤보 대상 (heal/magnet, y ∈ (singleJumpReach, doubleJumpReach])
  //   봇 "비행중 상승 수집" 로직이 상승 중 이단점프 자동 발동해서 잡음.
  // 이전 pri 개별 비교(`>`)는 지면 v=5(pri 5) 하나 vs 공중 v=5×2(합 10) 케이스 놓침
  //   (5 > 5 false → walking 유지 → 공중 놓침. 시드 962696644 회복부적×3 t≈218).
  // 지면 v=5 vs 공중 v=20 하나(pri 20) 같은 극단 케이스는 여전히 처리
  //   (20 > 5 → 해제). 지면 heal(pri 1000) vs 공중 v=5×N도 유지 (합 ≤ 100 << 1000).
  const doubleJumpReach =
    (r.jumpVelocity * r.jumpVelocity) / GRAVITY_ABS + jbH;
  let airCatchablePriSum = 0;
  const accumulateAir = (item: {
    x: number;
    y: number;
    value?: number;
    effect?: import("./stage").ItemEffect;
  }): void => {
    const isAirCatchable =
      item.effect !== undefined || (item.value ?? 1) >= 5;
    if (!isAirCatchable) return;
    const gap = item.x - r.x;
    if (gap < 0 || gap > range) return;
    // 단점프 도달 가능 (몸통 위, 정점 이하)
    if (item.y > jbH && item.y <= singleJumpReach) {
      airCatchablePriSum += effectivePri(item);
      return;
    }
    // 이단점프 콤보 대상 — heal/magnet만. 저가치 코인 이단점프 콤보는 flight 길어
    //   다른 catch·회피 놓칠 위험 대비 이득 작음 (봇 실제 로직도 heal/magnet만 콤보).
    if (
      (item.effect === "heal" || item.effect === "magnet") &&
      item.y > singleJumpReach &&
      item.y <= doubleJumpReach
    ) {
      airCatchablePriSum += effectivePri(item);
    }
  };
  for (let i = 0; i < world.currentTrack.items.length; i++) {
    if (world.currentItemCollected[i]) continue;
    accumulateAir(world.currentTrack.items[i]!);
  }
  for (const sp of world.spawnedItems) {
    if (sp.collected) continue;
    accumulateAir(sp);
  }
  // 임계값 K: 공중 합이 지면 pri보다 K배 이상 크면 해제. K=1이면 딱 넘으면.
  // 근거: 봇 catch 발동해도 공중 여러 개 실제로 다 잡는지는 궤도·timing에 달림 → 여유.
  //   벤치에서 튜닝. 부작용 크면 K 올림.
  const AIR_SUM_MARGIN_K = 3;
  if (airCatchablePriSum > groundProtectPri * AIR_SUM_MARGIN_K) return false;
  return true;
}

// 봇 착지 x 예측 — dash 활성/종료·auto 재활성 반영. 봇 currentEffSpeed(dash 활성 시 2배)로만
// 계산하면 봇 비행 중 dash 종료 시 착지 계산과 실제 크게 어긋남. 반대로 dash 비활성 상태에서
// 곧 cooldown 종료 시 봇 auto 활성 → 실제 착지 훨씬 앞 (신발×3 pit 낙사 케이스).
function predictLandingX(
  world: World,
  effSpeed: number,
  startX: number,
  tLand: number,
): number {
  const r = world.runner;
  if (tLand <= 0) return startX;
  const dashSkill = world.skills.find((s) => s.spec.id === "dash");
  const dashActive =
    (dashSkill?.activeTicks ?? 0) > 0 || r.itemDashTicks > 0;
  const dashSpeed = r.baseRunSpeed * 2;
  if (dashActive) {
    // dash 활성 중. 남은 시간 후 baseRunSpeed 복귀 예상.
    const dashRemainSec =
      Math.max(dashSkill?.activeTicks ?? 0, r.itemDashTicks) * TICK_DURATION;
    if (dashRemainSec >= tLand) return startX + effSpeed * tLand;
    return (
      startX +
      effSpeed * dashRemainSec +
      r.baseRunSpeed * (tLand - dashRemainSec)
    );
  }
  // dash 비활성. cooldown 종료 시 봇 auto 활성 → tLand 안 활성 예정이면 반영.
  if (dashSkill && dashSkill.cooldownTicks * TICK_DURATION < tLand) {
    const coolRemainSec = dashSkill.cooldownTicks * TICK_DURATION;
    const durationSec = dashSkill.durationTotalTicks * TICK_DURATION;
    const remainAfterCool = tLand - coolRemainSec;
    const dashDurInTLand = Math.min(remainAfterCool, durationSec);
    const afterDashDur = remainAfterCool - dashDurInTLand;
    return (
      startX +
      r.baseRunSpeed * coolRemainSec +
      dashSpeed * dashDurInTLand +
      r.baseRunSpeed * afterDashDur
    );
  }
  // dash 스킬 없거나 tLand 안 활성 예정 없음.
  return startX + effSpeed * tLand;
}

// 봇이 정점 도달 후 이단점프 발동 시 착지가 pit 안인지 검사. 봇 상승 중 발동 결정용.
// 봇 tToApex 후 이단점프 발동 시 pit 안 착지면 → 지금 이른 시점 이단점프로 pit 회피 필요.
function wouldLandAtApexInPit(
  world: World,
  effSpeed: number,
): boolean {
  const r = world.runner;
  const pits = visiblePits(world);
  if (pits.length === 0) return false;
  const tToApex = Math.max(0, r.vy / GRAVITY_ABS);
  const apexBefore =
    r.y + r.vy * tToApex - 0.5 * GRAVITY_ABS * tToApex * tToApex;
  const apexAfter =
    apexBefore + (r.jumpVelocity * r.jumpVelocity) / (2 * GRAVITY_ABS);
  const totalAir =
    tToApex +
    r.jumpVelocity / GRAVITY_ABS +
    Math.sqrt((2 * apexAfter) / GRAVITY_ABS);
  const landingLeft = predictLandingX(world, effSpeed, r.x, totalAir);
  const landingRight = landingLeft + r.baseWidth;
  const margin = PIT_SAFETY_MARGIN_SEC * effSpeed;
  for (const pit of pits) {
    if (
      landingRight > pit.x - margin &&
      landingLeft < pit.x + pit.width + margin
    )
      return true;
  }
  return false;
}

// 이단점프 발동 시 봇 착지 예상 위치가 pit 안인지 검사 (봇 현재 상태 + 이단점프 vy 반영).
// 이단점프하면 봇 vy = jumpVelocity로 재설정 → 새 정점 후 착지. 착지 x가 pit 안이면 낙사.
// 신발×3 등 빠른 봇이 큰 코인 잡으려 이단점프 → 상승 후 pit 안 착지하는 케이스 방지.
// 안전 마진(시간 단위)으로 pit 경계 아슬아슬 착지도 회피 — 봇 baseSpeed 환산 준수.
function wouldLandInPitAfterDouble(
  world: World,
  effSpeed: number,
  useMargin: boolean = true,
): boolean {
  const r = world.runner;
  const pits = visiblePits(world);
  if (pits.length === 0) return false;
  // 이단점프 후 vy = jumpVelocity. 봇 정점 = r.y + jV^2/(2g). 착지 시간 = jV/g + sqrt(2*정점/g).
  const apexAfter =
    r.y + (r.jumpVelocity * r.jumpVelocity) / (2 * GRAVITY_ABS);
  const totalAirAfter =
    r.jumpVelocity / GRAVITY_ABS +
    Math.sqrt((2 * apexAfter) / GRAVITY_ABS);
  // 착지 시점 봇 무적 예상이면 pit 위 안전 통과 (world.ts). skip.
  const dashSkill = world.skills.find((s) => s.spec.id === "dash");
  const dashActive = (dashSkill?.activeTicks ?? 0) > 0 || r.itemDashTicks > 0;
  const dashRemainSec = dashActive
    ? Math.max(dashSkill?.activeTicks ?? 0, r.itemDashTicks) * TICK_DURATION
    : 0;
  const dashActiveAtLanding = dashActive && dashRemainSec >= totalAirAfter;
  const dashAutoAtLanding =
    !dashActive &&
    dashSkill &&
    dashSkill.cooldownTicks * TICK_DURATION < totalAirAfter;
  const giantAtLanding = r.giantTicks * TICK_DURATION >= totalAirAfter;
  if (dashActiveAtLanding || dashAutoAtLanding || giantAtLanding) {
    return false;
  }
  const landingLeft = predictLandingX(world, effSpeed, r.x, totalAirAfter);
  const landingRight = landingLeft + r.baseWidth;
  // useMargin=false — 자연 낙하가 pit 안 확정 케이스에서 이단점프 발동 여부 판정용.
  // 어차피 자연 낙하로 낙사 확정이면 아슬아슬해도 이단점프 시도가 이득.
  const margin = useMargin ? PIT_SAFETY_MARGIN_SEC * effSpeed : 0;
  for (const pit of pits) {
    if (
      landingRight > pit.x - margin &&
      landingLeft < pit.x + pit.width + margin
    )
      return true;
  }
  return false;
}

export function decide(world: World): Input {
  const r = world.runner;
  const effSpeed = currentEffectiveSpeed(world);
  // 수집점프 트리거 zone — 봇 속도 반영 (baseSpeed 300 기준 20~70픽셀 유지)
  const jumpTriggerMin = JUMP_TRIGGER_MIN_SEC * effSpeed;
  const jumpTriggerMax = JUMP_TRIGGER_MAX_SEC * effSpeed;
  // 이 tick 봇 시야에 들어오는 장애물·구멍 — currentTrack의 살아있는 원소 + nextTrack 원소를
  // currentTrack 좌표계 절대 x로 합침. 트랙 이음새 너머 첫 장애물도 사각지대 없이 인지.
  const visibleObs = visibleObstacles(world);
  const visiblePitList = visiblePits(world);

  // 슬라이드 — 천장 장애물 통과 (파괴된 거 제외).
  // 지속 면역(dash/itemDash/giant) 시만 skip — 박스 안 줄여도 통과 가능.
  // 잔여 무적(invincibleTicks)은 곧 끝나므로 미리 슬라이드해서 무적 종료 시점에 이미
  // 박스가 줄어들어 있어야 충돌 안 함 — 회피점프 로직과 동일한 원칙.
  if (r.onGround && !isLastingImmune(world)) {
    const slideLookahead = SLIDE_TRIGGER_LOOKAHEAD_SEC * effSpeed;
    const slideTail = SLIDE_TRIGGER_TAIL_SEC * effSpeed;
    for (let i = 0; i < visibleObs.length; i++) {
      const o = visibleObs[i]!;
      const oYBottom = o.yBottom ?? 0;
      if (oYBottom === 0 || oYBottom >= r.baseHeight) continue;
      const oLeft = o.x;
      const oRight = o.x + o.width;
      const cRight = r.x + r.width;
      if (
        cRight > oLeft - slideLookahead &&
        r.x < oRight + slideTail
      ) {
        return { jump: false, slide: true, debugReason: "천장 슬라이드" };
      }
    }
  }

  if (r.onGround) {
    const immune = isObstacleImmune(world);
    const lastingImmune = isLastingImmune(world);
    // 보호 거리는 지속 면역(dash/itemDash/giant) 시만 늘림 — 봇 빠른 속도로 통과 범위 커서.
    // 잔여 무적(invincibleTicks)은 봇 일반 속도이므로 일반 범위로 충분.
    // 케이스: seed 4104791 봇 dash 종료 후 잔여 무적 중 obstacle 1800(파괴됨) 너머 magnet
    // 보호 범위가 500px라 (1564,80) heal 잡으러 점프 차단됨.
    const protectGroundRange =
      (lastingImmune ? GROUND_PROTECT_RANGE_IMMUNE_SEC : GROUND_PROTECT_RANGE_SEC) *
      effSpeed;
    const protectGround = nearGroundProtect(world, protectGroundRange);

    // 회피점프는 점프 정점이 장애물 부근에 정렬되어야 하므로 effective 속도 기준 시간으로.
    const avoidLowMin = AVOID_LOW_TRIGGER_MIN_SEC * effSpeed;
    const avoidLowMax = AVOID_LOW_TRIGGER_MAX_SEC * effSpeed;
    const avoidHighMin = AVOID_HIGH_TRIGGER_MIN_SEC * effSpeed;
    const avoidHighMax = AVOID_HIGH_TRIGGER_MAX_SEC * effSpeed;
    const highHeightLimit = singleJumpHeightLimit(world);

    // 봇이 점프할 때 실제 몸통 높이 — 거대화 시 baseHeight×2.
    const jbH = jumpBodyHeight(world);
    // 단점프로 도달 가능한 최대 코인 y (봇 실제 y + 정점 + 캐릭터 머리). 그 너머는
    // 어차피 못 잡으니 trigger X. 봇 plate 위(r.y=80)면 정점도 그만큼 위로.
    // 거대화 시 몸통이 커져 도달 y 확장 — jbH가 반영.
    const singleJumpReach =
      r.y + (r.jumpVelocity * r.jumpVelocity) / (2 * GRAVITY_ABS) + jbH;

    // 봇 단점프 후 지면(y=0) 도달까지 시간. 봇 평지(r.y=0)면 2*jV/g,
    // 플랫폼 위(r.y>0)면 낙차 반영해 더 길어짐.
    const flightTime =
      r.y > 0
        ? (r.jumpVelocity +
            Math.sqrt(
              r.jumpVelocity * r.jumpVelocity + 2 * GRAVITY_ABS * r.y,
            )) /
          GRAVITY_ABS
        : (2 * r.jumpVelocity) / GRAVITY_ABS;
    const flightDist = effSpeed * flightTime;
    const flightEnd = r.x + r.baseWidth + flightDist;

    // 회피 점프 — 큰 코인 대기보다 우선. 대기 도중 trigger 범위 지나치면 회피 못 함.
    // 지속 면역(dash/거대화/itemDash) 시만 skip. 잔여·충돌 무적은 곧 끝나므로
    // 미리 점프해서 무적 종료 시점에 이미 비행 중이게 만들어야 충돌 안 함.
    // 플랫폼도 회피점프 대상 — 봇이 낮은 장애물 트리거처럼 단점프해서 자연 plate 위 착지
    // (world.ts 단방향 처리). "기본 올라타 있기" 방침으로 plate를 회피 사이클 발판으로 활용.
    // 봇 단점프 후 ground 도달 위치 구멍 안인지 검사하는 헬퍼. 회피점프 skip 판정용이라
    // 마진 없이 pit 겹침만 검사 — 마진 확대 시 pit 옆 안전 착지도 skip → obstacle 회피 실패.
    // dash 종료 예측 반영 (predictLandingX) — 봇 비행 중 dash 종료 시 착지 위치 크게 앞당김.
    // 착지 시점 봇 무적(dash/거대화/itemDash) 상태면 world.ts에서 pit 위 지면 처리(낙사 X) →
    // 이 검사 skip. (dash 자동 활성 겹치면 봇 flight 커져 pit 안 착지지만 무적이라 안전.)
    const willLandInPit = (): boolean => {
      if (visiblePitList.length === 0) return false;
      // 착지 시점 봇 무적 상태 예상 여부
      const dashSkill = world.skills.find((s) => s.spec.id === "dash");
      const dashActive = (dashSkill?.activeTicks ?? 0) > 0 || r.itemDashTicks > 0;
      const dashRemainSec = dashActive
        ? Math.max(dashSkill?.activeTicks ?? 0, r.itemDashTicks) * TICK_DURATION
        : 0;
      const dashActiveAtLanding = dashActive && dashRemainSec >= flightTime;
      const dashAutoAtLanding =
        !dashActive &&
        dashSkill &&
        dashSkill.cooldownTicks * TICK_DURATION < flightTime;
      const giantAtLanding = r.giantTicks * TICK_DURATION >= flightTime;
      if (dashActiveAtLanding || dashAutoAtLanding || giantAtLanding) {
        return false; // 착지 시점 무적 예상 → pit 안전 통과
      }
      const landingLeft = predictLandingX(world, effSpeed, r.x, flightTime);
      const landingRight = landingLeft + r.baseWidth;
      for (const pit of visiblePitList) {
        if (landingRight > pit.x && landingLeft < pit.x + pit.width) {
          return true;
        }
      }
      return false;
    };

    // 봇 plate 위 상태 (r.onGround 이 분기 진입 조건에서 이미 true)
    const onPlatform = r.y > 0;

    // 봇 단점프 시작 후 정점에서 이단점프 보충하면 high obstacle 위 통과 가능한지 시뮬.
    // 봇 박스 [봇.y, 봇.y+baseHeight] vs obstacle [0, o.height] — 봇.y >= o.height면 통과.
    // 회피점프 nextObstacleTooClose 검사와 blocking check 두 곳에서 사용.
    const canDoubleJumpClearFrom = (
      startX: number,
      oX: number,
      oWidth: number,
      oHeight: number,
    ): boolean => {
      const tPeak = r.jumpVelocity / GRAVITY_ABS;
      const tEnter = (oX - r.baseWidth - startX) / effSpeed;
      const tExit = (oX + oWidth - startX) / effSpeed;
      if (tEnter < tPeak) return false; // 봇 정점 후 obstacle 진입이어야 보충 의미
      const yPeak = (r.jumpVelocity * r.jumpVelocity) / (2 * GRAVITY_ABS);
      const yAfterDj = (t: number): number => {
        const tau = t - tPeak;
        return (
          yPeak + r.jumpVelocity * tau - 0.5 * GRAVITY_ABS * tau * tau
        );
      };
      return yAfterDj(tEnter) >= oHeight && yAfterDj(tExit) >= oHeight;
    };
    const canDoubleJumpClear = (
      oX: number,
      oWidth: number,
      oHeight: number,
    ): boolean => canDoubleJumpClearFrom(r.x, oX, oWidth, oHeight);

    if (!lastingImmune) {
      for (let i = 0; i < visibleObs.length; i++) {
        const o = visibleObs[i]!;
        const oYBottom = o.yBottom ?? 0;
        if (oYBottom > 0) continue;
        // 봇 plate 위 상태 && 장애물 top이 봇 발 아래(같음 포함)면 자연 통과 — 회피점프 X.
        // 낮은 장애물(높이 30) 및 다음 plate(높이 80) 자동 skip. stuck 방지 (봇이 plate 위에서
        // 점프 → 다시 plate 착지로 우측 끝날 때까지 갇힘 방지).
        if (onPlatform && oYBottom + o.height <= r.y) continue;
        // 플랫폼 회피점프는 옵션(부수 발판) — 필수 회피 아님. 앞 지면에 보호 대상
        // (heal·v≥5 등)이 있으면 플랫폼 도약 skip → 봇 걸어가 자연 수집 우선.
        if (o.kind === "platform" && protectGround) continue;
        const gap = o.x - (r.x + r.width);
        // plate는 높이 80 — 낮은 장애물 트리거로 통일 (단점프 정점 127.8로 안전 착지)
        const isHigh =
          o.kind !== "platform" && o.height > highHeightLimit;
        const min = isHigh ? avoidHighMin : avoidLowMin;
        const max = isHigh ? avoidHighMax : avoidLowMax;
        // 봇 단점프 발동 후 ground 도달 위치가 구멍 안이면 발동 보류 (봇 ground 주행으로
        // 더 가까이 와서 발동 — 구멍 회피 분기에서 처리)
        // obstacle x가 randomObstacles로 소수점 값. gap 검사에서 borderline 오차로
        //   avoid trigger zone 진입 miss 하면 안 됨 — 봇 tick당 5px 이동인데
        //   0.5px 오차로 miss. baseSpeed 반영 마진 = 1 tick(effSpeed * dt)의 절반.
        //   seed 1565178987 t=529 H obs x=2754.543 gap=79.543 < MIN 80 → miss →
        //     회피점프 skip → 옆면 충돌. 마진 있으면 진입 안전.
        const gapMargin = 0.5 * effSpeed * TICK_DURATION;
        if (gap >= min - gapMargin && gap <= max + gapMargin && !willLandInPit()) {
          // 착지 후 다음 지면 obstacle과 회피 gap 확보되는지 검사 — 못 확보면 skip.
          // 회피점프 후 착지가 다음 obstacle에 avoid trigger MIN 미달이면 walking 회피
          // 못 하고 옆면 충돌 확정 → 오히려 이 obstacle에 그냥 충돌하고 무적으로 다음
          // obstacle 통과가 더 나음. BugReport #2: seed 293938927 tick 339 L(h=30) 회피점프
          //   → 착지 x=1929.5, 다음 H(x=2002) gap=72.5 < avoid_high MIN(80) → 옆면 충돌.
          let nextObstacleTooClose = false;
          for (let j = 0; j < visibleObs.length; j++) {
            if (j === i) continue;
            const nextO = visibleObs[j]!;
            if (nextO.kind === "platform") continue;
            if ((nextO.yBottom ?? 0) > 0) continue;
            if (nextO.x <= o.x) continue;
            const nextGap = nextO.x - flightEnd;
            if (nextGap <= 0) continue;
            const nextIsHigh = nextO.height > highHeightLimit;
            const nextMin = nextIsHigh ? avoidHighMin : avoidLowMin;
            if (nextGap < nextMin) {
              // 봇 회피점프 정점에서 이단점프 발동 시 새 flight arc가 다음 obstacle 통과
              //   가능하면 skip 안 함 — 봇 실제 정점에서 "정점 보충" 로직으로 이단점프 발동.
              // 케이스: BugReport #3 시드 1424073679 t=55 첫 obstacle x=899 h=30 회피 시
              //   착지 x=1316, 다음 obstacle x=1553 h=150. nextGap 207 < avoidHighMin 219
              //   → 원 로직 skip. 하지만 봇 정점 이단점프 시 새 flight가 (1553, 150) 통과 가능.
              //   신발×3 lv30 등 극단 세팅에서 avoidHighMin 크게 확장되어 자주 발동.
              if (!canDoubleJumpClear(nextO.x, nextO.width, nextO.height)) {
                nextObstacleTooClose = true;
              }
            }
            break; // 가장 가까운 다음 obstacle만 검사
          }
          // nextObstacleTooClose면 회피점프 skip. 회피 발동해도 착지 후 다음 obstacle 옆면
          //   확정이라 30 데미지 필연. arc 자연 catch 최대 이득(heal +10, coin +20 등)이
          //   30 손실 못 상쇄 → 어떤 아이템 잡아도 순 손해.
          //   → 회피 skip해서 봇 walking 유지 → 이 obstacle에 옆면 → 무적 60틱 → 다음
          //   obstacle 무적 통과 → 총 30 데미지 (같음)에 arc catch 손실 X.
          //   (원 fix #12는 hp>40 시 arc catch 이득 위해 감수했으나, heal이 10 hp라 순 손해.
          //   seed 1843602865 stage3-slides tick 430 케이스로 확인.)
          if (!nextObstacleTooClose) {
            // 봇 앞 [현재 위치, o.x - minReserve] 사이 지면 아이템 있으면 회피점프 지연 —
            // 봇이 걸어가 자연 수집 후에도 회피 발동 여유(min + 2 tick 이동거리) 남음.
            // 2 tick 여유: 매 tick 봇 이동 = effSpeed * dt. 지연 후 발동 판정 tick과
            // 실제 아이템 수집 tick 사이 gap 감소로 min 미달 되지 않도록 여유 확보.
            // 극단 세팅(+100)에서 46.3 px/tick라 이 여유 없으면 지연 chain이 회피 zone 놓침.
            // 패턴 1(구멍 회피 지면)·패턴 4(회피점프)에서 발견한 놓친 수집 사례 대응.
            const botFrontX = r.x + r.baseWidth;
            const minReserve = min + 2 * effSpeed * TICK_DURATION;
            if (hasGroundItemBefore(world, botFrontX, o.x, minReserve)) {
              // 지연 gap 여유 확보. 지연 후 봇 위치에서 다음 obstacle
              //   nextObstacleTooClose 상태가 새로 활성화되면 지연 후 회피 불가 →
              //   지연 안 하고 지금 즉시 회피 발동.
              // 케이스: 시드 1175943786 신발×3 lv20 t=1087 지연 판정 후, 지연 진행 중
              //   t=1093에 봇 x가 앞으로 이동해 다음 obstacle 6935.3(h=150) 근접 →
              //   nextObstacleTooClose 활성화 → 회피 skip → 옆면 충돌 사망.
              //   지금 시점(t=1087)에 지연 후 상황 시뮬해서 nextObstacleTooClose 예상되면 즉시 회피.
              const lastX = lastGroundItemXBefore(world, botFrontX, o.x);
              // 봇 자연 수집 시점 봇 우측 = lastX (봇 x = lastX - baseWidth) 넘어야 지남.
              // 이산 tick 반영: (필요 dx)/(tick당 이동) 반올림해서 실제 봇 x 예상.
              const perTick = effSpeed * TICK_DURATION;
              const nTicksToPass =
                perTick > 0
                  ? Math.max(0, Math.ceil((lastX - r.baseWidth - r.x) / perTick))
                  : 0;
              const botXAfterDelay = r.x + nTicksToPass * perTick;
              const flightEndAfterDelay =
                botXAfterDelay + r.baseWidth + flightDist;
              let nextTooCloseAfterDelay = false;
              for (let j = 0; j < visibleObs.length; j++) {
                if (j === i) continue;
                const nextO = visibleObs[j]!;
                if (nextO.kind === "platform") continue;
                if ((nextO.yBottom ?? 0) > 0) continue;
                if (nextO.x <= o.x) continue;
                const nextGap = nextO.x - flightEndAfterDelay;
                if (nextGap <= 0) continue;
                const nextIsHigh = nextO.height > highHeightLimit;
                const nextMin = nextIsHigh ? avoidHighMin : avoidLowMin;
                if (nextGap < nextMin) {
                  if (
                    !canDoubleJumpClearFrom(
                      botXAfterDelay,
                      nextO.x,
                      nextO.width,
                      nextO.height,
                    )
                  ) {
                    nextTooCloseAfterDelay = true;
                  }
                }
                break;
              }
              if (nextTooCloseAfterDelay) {
                // 지연 후 회피 불가 → 지금 즉시 회피
                return { jump: true, slide: false, debugReason: "회피점프" };
              }
              continue;
            }
            return { jump: true, slide: false, debugReason: "회피점프" };
          }
        }
      }
    }

    // plate 위 상태 && 앞 지면 근처에 회복 아이템 감지 → 슬라이드 하강해서 획득.
    // 낙하 시간 약 0.27s × baseSpeed ≈ 81px 이동 → 지면 도달 후 자연스레 heal 통과.
    // 300px 감지 범위는 봇 낙하 + 접근 여유 (튜닝 여지 있음).
    if (onPlatform && !lastingImmune) {
      const HEAL_DESCEND_RANGE = 300;
      const runnerRight = r.x + r.baseWidth;
      let healAhead = false;
      for (let i = 0; i < world.currentTrack.items.length; i++) {
        if (world.currentItemCollected[i]) continue;
        const it = world.currentTrack.items[i]!;
        if (it.effect !== "heal") continue;
        if (it.y > r.baseHeight) continue;
        const gap = it.x - runnerRight;
        if (gap >= 0 && gap <= HEAL_DESCEND_RANGE) {
          healAhead = true;
          break;
        }
      }
      if (!healAhead) {
        for (const sp of world.spawnedItems) {
          if (sp.collected) continue;
          if (sp.effect !== "heal") continue;
          if (sp.y > r.baseHeight) continue;
          const gap = sp.x - runnerRight;
          if (gap >= 0 && gap <= HEAL_DESCEND_RANGE) {
            healAhead = true;
            break;
          }
        }
      }
      if (healAhead) return { jump: false, slide: true, debugReason: "회복 하강" };

      // 코인 뭉치 하강 — 앞 지면 근처 코인 총 가치가 임계값 이상이면 슬라이드 하강.
      // 임계값 15: coin5 3개 / coin20 1개 / coin1 15개 등. 튜닝 여지 있음.
      const COIN_DESCEND_THRESHOLD = 15;
      let coinValueAhead = 0;
      for (let i = 0; i < world.currentTrack.items.length; i++) {
        if (world.currentItemCollected[i]) continue;
        const it = world.currentTrack.items[i]!;
        if (it.effect) continue;
        if (it.y > r.baseHeight) continue;
        const gap = it.x - runnerRight;
        if (gap >= 0 && gap <= HEAL_DESCEND_RANGE) {
          coinValueAhead += it.value ?? 1;
        }
      }
      for (const sp of world.spawnedItems) {
        if (sp.collected) continue;
        if (sp.effect) continue;
        if (sp.y > r.baseHeight) continue;
        const gap = sp.x - runnerRight;
        if (gap >= 0 && gap <= HEAL_DESCEND_RANGE) {
          coinValueAhead += sp.value ?? 1;
        }
      }
      if (coinValueAhead >= COIN_DESCEND_THRESHOLD)
        return { jump: false, slide: true, debugReason: "코인뭉치 하강" };

      // 플랫폼 위 → 앞 공중 heal·v≥5 코인이 플랫폼 위쪽~top 근처(y > baseHeight)에 있고
      // 봇 walking-off 궤도(플랫폼 벗어난 뒤 낙하)로는 못 잡지만 단점프 궤도 하강 부분이
      // 정렬되면 잡을 수 있음 — 이럴 때 발동. 봇이 플랫폼 위 걸어가다 y가 급격히
      // 떨어져 heal 못 잡는 케이스.
      let plateForBot: import("./stage").Obstacle | null = null;
      for (const o of visibleObs) {
        if (o.kind !== "platform") continue;
        const oYTop = (o.yBottom ?? 0) + o.height;
        if (
          Math.abs(r.y - oYTop) < 0.5 &&
          r.x + r.baseWidth > o.x &&
          r.x < o.x + o.width
        ) {
          plateForBot = o;
          break;
        }
      }
      if (plateForBot) {
        const plateRight = plateForBot.x + plateForBot.width;
        // 봇 단점프 궤도 상 obstacle 옆면 충돌 예상 검사 — 플랫폼 도약 발동 skip 용.
        // 봇 flight arc가 지상 장애물·천장 장애물 옆면과 겹치면 착지 후 슬라이드로도 못 피함
        // (world.ts 착지 tick 안 obstacle 충돌이 슬라이드 반영 후에 판정되지만 봇 body 이미
        // 겹쳐 있으면 늦음). blockingObstacleAhead 유사 logic 인라인.
        const jumpTrajectoryHitsObstacle = (): boolean => {
          for (const o of visibleObs) {
            if (o.kind === "platform") continue;
            const oYBottom = o.yBottom ?? 0;
            const oYTop = oYBottom + o.height;
            const tEnter = Math.max(
              0,
              (o.x - r.baseWidth - r.x) / effSpeed,
            );
            const tExit = Math.min(
              flightTime,
              (o.x + o.width - r.x) / effSpeed,
            );
            if (tEnter < tExit) {
              const tPeak = r.jumpVelocity / GRAVITY_ABS;
              const yAt = (t: number) =>
                r.y + r.jumpVelocity * t - 0.5 * GRAVITY_ABS * t * t;
              let yMin = Math.min(yAt(tEnter), yAt(tExit));
              let yMax = Math.max(yAt(tEnter), yAt(tExit));
              if (tPeak > tEnter && tPeak < tExit) {
                yMax = Math.max(yMax, yAt(tPeak));
              }
              if (yMax + r.baseHeight > oYBottom && yMin < oYTop) {
                return true;
              }
            }
            // 착지 시 body 겹침 (지상 obstacle 또는 낮게 걸린 천장)
            if (o.x >= flightEnd) {
              if (oYBottom === 0) {
                // 착지 후 walking으로 avoid trigger zone 진입 가능해야 안전 —
                // 착지 gap이 obstacle 높이별 avoid MIN 미달이면 트리거 놓치고 옆면 충돌.
                // BugReport #5(seed 311701551/1747332858, stage2-jumps): 플랫폼 도약 후
                //   착지 gap 75 < AVOID_HIGH_MIN 80 → walking 15틱 → H150 벽 옆면 충돌.
                const isHigh = o.height > highHeightLimit;
                const avoidMinSec = isHigh
                  ? AVOID_HIGH_TRIGGER_MIN_SEC
                  : AVOID_LOW_TRIGGER_MIN_SEC;
                if (o.x < flightEnd + avoidMinSec * effSpeed) {
                  return true;
                }
              } else if (oYBottom < r.baseHeight) {
                if (flightEnd > o.x && flightEnd - r.baseWidth < o.x + o.width) {
                  return true;
                }
              }
            }
          }
          return false;
        };
        const isPlateJumpValuable = (item: {
          value?: number;
          effect?: import("./stage").ItemEffect;
        }): boolean =>
          item.effect === "heal" ||
          item.effect === "magnet" ||
          (item.value ?? 1) >= 5;
        // 봇 walking-off 궤도가 item 자연 수집하는지 검사 — 플랫폼 벗어난 시점부터 낙하
        const walkOffCatches = (itemX: number, itemY: number): boolean => {
          if (itemX <= plateRight) {
            // 아직 플랫폼 위 — 봇 걸어가 body 겹침
            return itemY >= r.y && itemY <= r.y + jbH;
          }
          // 플랫폼 벗어난 뒤 낙하 궤도
          const fallTime = (itemX - plateRight) / effSpeed;
          const yAtFall = r.y - 0.5 * GRAVITY_ABS * fallTime * fallTime;
          if (yAtFall < 0) {
            // 봇 착지 후 walking — body [0, jbH]
            return itemY >= 0 && itemY <= jbH;
          }
          return itemY >= yAtFall && itemY <= yAtFall + jbH;
        };
        // 봇 단점프 궤도가 item 잡는지 검사 (canCatchGround 논리 미리 인라인)
        const jumpCatches = (itemX: number, itemY: number): boolean => {
          if (effSpeed <= 0) return false;
          const t = (itemX - r.x) / effSpeed;
          if (t <= 0) return false;
          const yAtT =
            r.y + r.jumpVelocity * t - 0.5 * GRAVITY_ABS * t * t;
          if (yAtT < 0) return false;
          return itemY >= yAtT && itemY <= yAtT + jbH;
        };
        const considerPlateJump = (
          itemX: number,
          itemY: number,
          value: number | undefined,
          effect: import("./stage").ItemEffect | undefined,
        ): boolean => {
          if (!isPlateJumpValuable({ value, effect })) return false;
          if (itemX <= r.x + r.baseWidth) return false;
          if (walkOffCatches(itemX, itemY)) return false;
          return jumpCatches(itemX, itemY);
        };
        // 도약 후보 발견 시 궤도 obstacle 충돌 검사 (한 번만).
        // 후보 없으면 계산 skip.
        let plateJumpFires = false;
        for (let i = 0; !plateJumpFires && i < world.currentTrack.items.length; i++) {
          if (world.currentItemCollected[i]) continue;
          const it = world.currentTrack.items[i]!;
          if (considerPlateJump(it.x, it.y, it.value, it.effect)) {
            plateJumpFires = true;
          }
        }
        for (const sp of world.spawnedItems) {
          if (plateJumpFires) break;
          if (sp.collected) continue;
          if (considerPlateJump(sp.x, sp.y, sp.value, sp.effect)) {
            plateJumpFires = true;
          }
        }
        // 플랫폼 도약 후 착지 예상 위치가 pit 안이면 발동 skip.
        // 봇 발판 위 상태 flightTime은 낙차 반영으로 길어짐 → predictLandingX로 dash 반영 착지 예측.
        const plateJumpLandsInPit = (): boolean => {
          if (visiblePitList.length === 0) return false;
          const landX = predictLandingX(world, effSpeed, r.x, flightTime);
          const landRight = landX + r.baseWidth;
          const pitSafety = PIT_SAFETY_MARGIN_SEC * effSpeed;
          for (const pit of visiblePitList) {
            if (
              landRight > pit.x - pitSafety &&
              landX < pit.x + pit.width + pitSafety
            ) {
              return true;
            }
          }
          return false;
        };
        if (
          plateJumpFires &&
          !jumpTrajectoryHitsObstacle() &&
          !plateJumpLandsInPit()
        ) {
          return { jump: true, slide: false, debugReason: "플랫폼 도약" };
        }
      }

      // 트랙 끝 근접 발판이면 미리 슬라이드로 하강 — walkoff 하면 하강 상태로 새 트랙 진입해
      // 첫 지상 장애물 앞 착지 gap 부족으로 옆면 충돌. 지금 슬라이드하면 봇 발판에서 발이
      // 떨어져 자연 낙하 시작(stage.ts platform 정의). 트랙 끝 이전에 지면 착지하면 다음 트랙에
      // 지면 상태로 진입 가능 → visibleObstacles(nextTrack 포함)로 첫 벽 정상 회피.
      // 케이스: seed 1520937095/2066557580 신발×3 stage3-slides/stage4-mixed 진입 사망.
      if (plateForBot) {
        const plateRight = plateForBot.x + plateForBot.width;
        const trackEnd = world.currentTrack.length;
        // 지금 그대로 걷다가 발판 우측 끝에서 walkoff 시나리오
        const walkTimeToPlateRight =
          Math.max(0, (plateRight - r.x - r.baseWidth) / effSpeed);
        const fallTime = Math.sqrt((2 * r.y) / GRAVITY_ABS);
        const walkoffLandX = plateRight + effSpeed * fallTime;
        if (walkoffLandX > trackEnd) {
          // 지면 착지가 다음 트랙 안 — 진입 x 계산
          const nextLandX = walkoffLandX - trackEnd;
          // 다음 트랙 첫 지상 장애물 (플랫폼 제외)
          let firstObs: import("./stage").Obstacle | null = null;
          for (const o of world.nextTrack.obstacles) {
            if (o.kind === "platform") continue;
            if ((o.yBottom ?? 0) > 0) continue;
            if (firstObs === null || o.x < firstObs.x) firstObs = o;
          }
          if (firstObs) {
            const gap = firstObs.x - (nextLandX + r.baseWidth);
            const isHigh = firstObs.height > highHeightLimit;
            const avoidMinSec = isHigh
              ? AVOID_HIGH_TRIGGER_MIN_SEC
              : AVOID_LOW_TRIGGER_MIN_SEC;
            const avoidMin = avoidMinSec * effSpeed;
            if (gap >= 0 && gap < avoidMin) {
              // 위험 — 지금 슬라이드 하강해서 wrap 이전 지면 착지 가능한지 확인
              const nowLandX = r.x + effSpeed * fallTime;
              if (nowLandX < trackEnd) {
                return {
                  jump: false,
                  slide: true,
                  debugReason: "트랙 끝 발판 미리 하강",
                };
              }
            }
          }
        }
      }
    }

    // 구멍 회피 — 봇이 구멍 좌측 도달 직전 단점프 발동. 봇 단점프 비행 거리 안에서
    // 구멍 우측 너머 착지 가능해야 안전.
    // lastingImmune(dash/거대화/itemDash) 조건 없음 — 무적은 장애물 대응이지 pit(지면 없음)에는
    // 무관. dash 중이라도 pit는 반드시 뛰어넘어야 함. dash 속도 2배로 flightDist 커져서
    // pit 폭 80~130은 여유롭게 통과.
    if (r.onGround) {
      const pitTriggerMax = PIT_TRIGGER_LOOKAHEAD_SEC * effSpeed;
      const pitSafetyMargin = PIT_SAFETY_MARGIN_SEC * effSpeed;
      // 실제 착지 위치는 dash 종료·auto 활성 반영해야 정확 (dash 활성 중 flight 도중 종료 시
      // 속도 감속 → 봇 예측보다 짧게 착지). flightDist 기준 발동 조건은 이 감속 반영 안 함 →
      // 봇 dash 종료로 pit 안 착지 사망. predictLandingX로 통일해 정확한 착지 예측.
      const predictedLandX = predictLandingX(world, effSpeed, r.x, flightTime);
      const predictedLandRight = predictedLandX + r.baseWidth;
      for (const pit of visiblePitList) {
        const gap = pit.x - (r.x + r.baseWidth);
        if (gap < 0) continue; // 봇 이미 구멍 위
        if (gap > pitTriggerMax) continue; // 너무 멀음, 아직 발동 안 함
        // 봇 단점프 비행 후 실제 착지 위치가 pit 우측 너머 + 안전 마진 보장
        if (predictedLandRight >= pit.x + pit.width + pitSafetyMargin) {
          // 연쇄 pit 검사 — 봇 flight arc 착지 위치가 다른 pit 안이면 skip.
          let landsInAnotherPit = false;
          for (const otherPit of visiblePitList) {
            if (otherPit === pit) continue;
            if (
              predictedLandRight > otherPit.x - pitSafetyMargin &&
              predictedLandX < otherPit.x + otherPit.width + pitSafetyMargin
            ) {
              landsInAnotherPit = true;
              break;
            }
          }
          if (landsInAnotherPit) continue; // 다음 pit 위 착지 위험 → 이 pit 회피 skip
          // 봇 앞 [현재 위치, pit.x - reserve] 사이 지면 아이템 있으면 지연 —
          // reserve = pitSafetyMargin + 2 tick 이동거리(회피점프 지연과 동일 이유).
          // 봇이 걸어가 자연 수집 후 pit 앞 도착 시 재발동. 패턴 1(구멍 회피 지면) 대응.
          const botFrontX = r.x + r.baseWidth;
          const pitReserve = pitSafetyMargin + 2 * effSpeed * TICK_DURATION;
          if (hasGroundItemBefore(world, botFrontX, pit.x, pitReserve)) {
            continue;
          }
          return { jump: true, slide: false, debugReason: "구멍 회피 지면" };
        }
      }
    }


    // === 트리거 zone 안 catchable 후보 priority (단점프) 미리 계산 ===
    // wait/jump 결정에 같이 사용 — 더 큰 가치 catch 가능하면 더 멀리 있는 valuable 대기 안 함.
    const canCatchGround = (itemX: number, itemY: number): boolean => {
      if (effSpeed <= 0) return false;
      const t = (itemX - r.x) / effSpeed;
      if (t <= 0) return false;
      // 봇 실제 y(r.y) 반영 — plate 위(r.y>0) 상태에서도 정확한 정점 판정.
      const yAtT = r.y + r.jumpVelocity * t - 0.5 * GRAVITY_ABS * t * t;
      if (yAtT < 0) return false;
      return itemY >= yAtT && itemY <= yAtT + jbH;
    };
    // 지면 봇이 단점프+정점 이단점프 콤보로 catch 가능한지 (heal/magnet 같은 y > singleJumpReach
    // effect 아이템용). 콤보 궤도 두번째 정점 y = jV²/g 로 y = 255.7 + jbH 까지 도달.
    // 3 phase: [0, tPeak] 단점프 상승, [tPeak, 2*tPeak] 이단점프 상승, [2*tPeak, ...] 하강.
    const canCatchDoubleJump = (itemX: number, itemY: number): boolean => {
      if (effSpeed <= 0) return false;
      if (r.y > 0) return false; // 지면 봇 전용
      const t = (itemX - r.x) / effSpeed;
      if (t <= 0) return false;
      const jV = r.jumpVelocity;
      const g = GRAVITY_ABS;
      const tPeak = jV / g;
      const y1 = (jV * jV) / (2 * g); // 첫 정점 y
      let y: number;
      if (t <= tPeak) {
        y = jV * t - 0.5 * g * t * t;
      } else if (t <= 2 * tPeak) {
        const tau = t - tPeak;
        y = y1 + jV * tau - 0.5 * g * tau * tau;
      } else {
        const tau = t - 2 * tPeak;
        y = 2 * y1 - 0.5 * g * tau * tau;
      }
      if (y < 0) return false;
      return itemY >= y && itemY <= y + jbH;
    };
    const doubleJumpReach = r.y + (r.jumpVelocity * r.jumpVelocity) / GRAVITY_ABS + jbH;
    // 콤보 flight 시간 = 단점프 상승 + 이단점프 상승 + 두번째 정점에서 착지까지 하강.
    // = tPeak + tPeak + sqrt(2*y2/g). 이 안 heal 도달해야 콤보 catch 궤도.
    const doubleJumpFlightDist = (() => {
      const jV = r.jumpVelocity;
      const g = GRAVITY_ABS;
      const tPeak = jV / g;
      const y2 = (jV * jV) / g; // 두 번째 정점 y (지면 봇 기준)
      const tLandFromPeak2 = Math.sqrt((2 * y2) / g);
      return effSpeed * (2 * tPeak + tLandFromPeak2);
    })();
    let catchableNowPri = -1;
    // 봇 몸통 [r.y, r.y+jbH] 안 코인은 자연 수집(걸어가면 잡힘) — 점프 트리거 X.
    // 지면 봇(r.y=0)이면 몸통 [0,jbH] 이하가 자연 수집 범위. 거대화 시 jbH=100.
    // gap 상한만 jumpTriggerMax로 제한. 하한은 canCatchGround로 판정 — 거대화·높은
    // item 등은 gap 작아도 rise arc 조기 catch 가능.
    // catch trigger 상한 확장 — jumpTriggerMax + 여유. 봇이 trigger MAX 딱 넘겨서 catch 놓치는
    // 케이스 (gap 70~80 사이 catchable) 커버. blocking check가 뒤에서 안전 판정하므로 여유 확장 안전.
    // 시드 659280729 t=309 x=1545 item(1619,120) gap=74 케이스: 이 확장 없으면 catch 놓침 →
    // 봇이 다음 tick trigger 진입해도 blocking으로 skip → 결국 미수집.
    const jumpTriggerCatchExt = jumpTriggerMax + 10;
    for (let i = 0; i < world.currentTrack.items.length; i++) {
      if (world.currentItemCollected[i]) continue;
      const item = world.currentTrack.items[i]!;
      if (item.y <= r.y + jbH) continue;
      if (item.y > singleJumpReach) continue;
      const gap = item.x - r.x;
      if (gap <= 0 || gap > jumpTriggerCatchExt) continue;
      if (!canCatchGround(item.x, item.y)) continue;
      const pri = itemPriority(item);
      if (pri > catchableNowPri) catchableNowPri = pri;
    }
    for (const sp of world.spawnedItems) {
      if (sp.collected) continue;
      if (sp.y <= r.y + jbH) continue;
      if (sp.y > singleJumpReach) continue;
      const gap = sp.x - r.x;
      if (gap <= 0 || gap > jumpTriggerCatchExt) continue;
      if (!canCatchGround(sp.x, sp.y)) continue;
      const pri = itemPriority(sp);
      if (pri > catchableNowPri) catchableNowPri = pri;
    }

    // 이단점프 콤보 catch — 단점프로 못 잡는 heal/magnet(y > singleJumpReach)을 정점 이단점프
    // 보충으로 잡음. 대상은 heal·magnet(pri≥1000)만 — 저가치(코인 v=20 pri=20)는 콤보 flight
    // 길어(0.68s) obstacle·pit·다른 catch 놓칠 위험 대비 이득 작음.
    // 시드 736305561 t=890 heal(y=210) 케이스: 자석 종료 후 봇이 이단점프 콤보로만 잡을 수
    //   있는데 단점프 판정만 있어 감지 못 함 → walking → 놓침.
    // 봇 단점프 발동 후 상승 중 "비행중 상승 수집"(line 1197) 로직이 정점 근처에서
    //   이단점프 자동 발동해 heal catch.
    if (r.y === 0) {
      const considerCombo = (
        itemX: number,
        itemY: number,
        effect: import("./stage").ItemEffect | undefined,
      ): void => {
        if (effect !== "heal" && effect !== "magnet") return;
        if (itemY <= singleJumpReach) return;
        if (itemY > doubleJumpReach) return;
        const gap = itemX - r.x;
        if (gap <= 0 || gap > doubleJumpFlightDist) return;
        if (!canCatchDoubleJump(itemX, itemY)) return;
        const pri = itemPriority({ effect } as Item);
        if (pri > catchableNowPri) catchableNowPri = pri;
      };
      for (let i = 0; i < world.currentTrack.items.length; i++) {
        if (world.currentItemCollected[i]) continue;
        const item = world.currentTrack.items[i]!;
        considerCombo(item.x, item.y, item.effect);
      }
      for (const sp of world.spawnedItems) {
        if (sp.collected) continue;
        considerCombo(sp.x, sp.y, sp.effect);
      }
    }

    // 비행 영역 안에 큰 코인(v≥5)이 있고 아직 trigger 거리 밖이면 점프 대기.
    // 단, 봇과 그 코인 사이에 ground 장애물이 있으면 회피가 더 급하니 대기 X.
    // 단, 트리거 zone 안 catchable 후보 우선순위가 wait 대상보다 크거나 같으면 대기 X —
    // 가치 작은 것 대기하다 지금 잡을 큰 거 놓치는 손해 (케이스: seed 158120043
    // (1183.5,80) v=20 캐치 가능한데 (1230,120) (1273.8,80) v=5 대기로 미스).
    let waitForValuablePri = 0;
    const hasGroundObstacleBetween = (untilX: number): boolean => {
      for (let i = 0; i < visibleObs.length; i++) {
        const o = visibleObs[i]!;
        if ((o.yBottom ?? 0) > 0) continue;
        if (o.x > r.x && o.x < untilX) return true;
      }
      return false;
    };
    // 큰 코인 도달 전에 trigger 거리 안에 들어올 effect 아이템(회복·자석 등) 있는지 검사 —
    // 있으면 그 effect 먼저 잡으러 가야 하니 wait 해제.
    const hasTriggerableEffectBefore = (untilX: number): boolean => {
      for (let i = 0; i < world.currentTrack.items.length; i++) {
        if (world.currentItemCollected[i]) continue;
        const it = world.currentTrack.items[i]!;
        if (!it.effect) continue;
        if (it.y <= jbH) continue;
        if (it.y > singleJumpReach) continue;
        if (it.x >= untilX) continue;
        const gap = it.x - r.x;
        if (gap >= jumpTriggerMin && gap <= jumpTriggerMax) return true;
      }
      for (const sp of world.spawnedItems) {
        if (sp.collected) continue;
        if (!sp.effect) continue;
        if (sp.y <= jbH) continue;
        if (sp.y > singleJumpReach) continue;
        if (sp.x >= untilX) continue;
        const gap = sp.x - r.x;
        if (gap >= jumpTriggerMin && gap <= jumpTriggerMax) return true;
      }
      return false;
    };
    // 봇이 trigger zone(gap=jumpTriggerMin~jumpTriggerMax)에 진입했을 때 단점프해서
    // item 박스에 닿을 수 있는 시점이 있는지 검사. dash 활성 시 effSpeed 빠르면
    // 비행 trajectory가 짧은 시간 안 itemY 못 닿아 못 잡는 케이스 차단.
    const willCatchInTriggerZone = (itemY: number): boolean => {
      if (effSpeed <= 0) return false;
      for (let g = jumpTriggerMin; g <= jumpTriggerMax; g += 5) {
        const t = g / effSpeed;
        // 봇 실제 y(r.y) 반영 — plate 위 상태에서도 정확한 trajectory.
        const yAtT = r.y + r.jumpVelocity * t - 0.5 * GRAVITY_ABS * t * t;
        if (yAtT < 0) continue;
        if (itemY >= yAtT && itemY <= yAtT + jbH) return true;
      }
      return false;
    };
    const checkValuable = (
      itemX: number,
      itemY: number,
      value: number | undefined,
      effect: ItemEffect | undefined,
    ): boolean => {
      // effect 아이템(heal/magnet/dash/giant) 또는 v≥5 코인이라야 대기 가치 있음.
      // 일반 코인(v=1)은 작아서 대기로 인한 다른 trigger 손실이 더 큼.
      if (!effect && (value ?? 1) < 5) return false;
      // 봇 몸통 안 코인은 자연 수집이므로 대기 대상 아님 (봇 실제 y 반영).
      if (itemY <= r.y + jbH) return false;
      if (itemY > singleJumpReach) return false;
      const gap = itemX - r.x;
      if (gap <= jumpTriggerMax || gap > flightDist) return false;
      // 봇 ~ 코인 사이 ground 장애물 있으면 그 회피가 우선이라 대기 X
      if (hasGroundObstacleBetween(itemX)) return false;
      // 봇 ~ 코인 사이 trigger 거리 안 effect 아이템 있으면 그것 먼저 잡으러 — 대기 X
      if (hasTriggerableEffectBefore(itemX)) return false;
      // 봇이 trigger zone에 들어와 단점프해도 닿을 수 없는 item이면 대기 X
      // (dash 활성 시 effSpeed 빠르면 비행 trajectory가 itemY 못 닿는 케이스)
      if (!willCatchInTriggerZone(itemY)) return false;
      return true;
    };
    for (let i = 0; i < world.currentTrack.items.length; i++) {
      if (world.currentItemCollected[i]) continue;
      const item = world.currentTrack.items[i]!;
      if (checkValuable(item.x, item.y, item.value, item.effect)) {
        const pri = itemPriority(item);
        if (pri > waitForValuablePri) waitForValuablePri = pri;
      }
    }
    for (const sp of world.spawnedItems) {
      if (sp.collected) continue;
      if (checkValuable(sp.x, sp.y, sp.value, sp.effect)) {
        const pri = itemPriority(sp);
        if (pri > waitForValuablePri) waitForValuablePri = pri;
      }
    }
    if (waitForValuablePri > 0 && waitForValuablePri > catchableNowPri) {
      // 대기 가치 있는 아이템(waitForValuablePri > 0)이 실제 있을 때만 대기.
      // 초기값 0 > catchableNowPri 초기값 -1 이라 이 조건 없으면 실제 대기 대상 없어도
      // 대기 로직 발동 → 봇 회피점프 트리거 놓쳐 obstacle 옆면 충돌.
      // BugReport #2: seed 293938927 tick 379~ 봇 지면 착지 후 앞 highGround gap 108→33
      //   walking하는 동안 계속 "큰코인 대기" why → avoid_high 트리거 zone(80~105) 놓침.
      // hp 위험 상태에서는 heal/magnet(pri>=1000) 아닌 대기 skip — 저가치(v>=5 코인,
      // dash/giant) 대기하다 obstacle collision 30 데미지로 사망 위험. 대기 가치보다
      // 생존 우선. heal(1000)과 magnet(1500)은 근본 회복·파밍 도구라 hp 낮아도 유지.
      // 단, 대기 가치가 catch 가치의 5배 이상이면 hp 위험이어도 대기 유지 — 저가치 catch
      // (c1 pri 1) 잡으려 훨씬 큰 c20(pri 20) 놓치는 손해 방지.
      // 시드 736305561: hp=6에서 c1(pri 1) 수집점프 → flight arc 중 c20(pri 20) 지나감.
      const hpDangerous = r.hp < r.maxHp * 0.4;
      const waitMuchBetter =
        catchableNowPri < 5 && waitForValuablePri >= catchableNowPri * 5;
      if (!hpDangerous || waitForValuablePri >= 1000 || waitMuchBetter) {
        return { jump: false, slide: false, debugReason: "큰코인 대기" };
      }
      // skip → 흐름 계속 (catch-jump 등 하위 분기로)
    }

    // catch 결정 궤도 시뮬 스코어링 (갑안) — catch vs skip 각 시나리오 짧게 시뮬해서
    // 잡을 아이템 pri 합 비교. catch가 궤도로 지나쳐 놓칠 지면 큰 아이템이 skip보다
    // 큰 이득이면 대기. 봇 매 tick 결정은 그대로 유지, 이 스코어링은 catch 후보 있을 때만.
    // 사용자 케이스 (황태+금붕어+코인반지×3 시드 1887212460 t≈1131): 봇 x=3050에서
    //   catch (3079,80) v=5 이후 궤도 확장 → (3268,0) v=20 놓침. skip이 순이득 +15.
    if (catchableNowPri > 0 && r.onGround && !lastingImmune) {
      const SIM_TICKS = 60; // 봇 이단점프 flight ~ 41틱 + 여유
      const g = GRAVITY_ABS;
      const bH = r.baseHeight;
      const bW = r.baseWidth;
      // 시뮬 안 아이템 잡음 여부 판정 — 봇 몸통과 겹침 (magnet·거대화 반영 X, 근사).
      const simScore = (doJump: boolean): number => {
        let x = r.x;
        let y = r.y;
        let vy = r.vy;
        let jL = r.jumpsLeft;
        let onG = r.onGround;
        if (doJump && jL > 0) {
          vy = r.jumpVelocity;
          jL--;
          onG = false;
        }
        let pri = 0;
        const collectedStatic = new Set<number>();
        const collectedSpawn = new Set<number>();
        let landedAfterJump = false;
        for (let step = 0; step < SIM_TICKS; step++) {
          vy += -g * TICK_DURATION; // GRAVITY_ABS는 절댓값
          x += effSpeed * TICK_DURATION;
          y += vy * TICK_DURATION;
          if (y <= 0) {
            y = 0;
            vy = 0;
            onG = true;
            if (doJump) landedAfterJump = true;
          }
          // catch 시나리오에서 착지 후는 카운트 안 함 — 실제 봇이 이 시점에 이단점프
          // ("비행중 상승 수집") 발동할 위험이 있어 궤도 확장. 착지 예측 낙관적일 수 있음.
          if (doJump && landedAfterJump) break;
          // 정적 아이템 잡음 판정
          for (let i = 0; i < world.currentTrack.items.length; i++) {
            if (world.currentItemCollected[i]) continue;
            if (collectedStatic.has(i)) continue;
            const it = world.currentTrack.items[i]!;
            if (
              it.x >= x &&
              it.x <= x + bW &&
              it.y >= y &&
              it.y <= y + bH
            ) {
              pri += itemPriority(it);
              collectedStatic.add(i);
            }
          }
          for (let j = 0; j < world.spawnedItems.length; j++) {
            const sp = world.spawnedItems[j]!;
            if (sp.collected) continue;
            if (collectedSpawn.has(j)) continue;
            if (
              sp.x >= x &&
              sp.x <= x + bW &&
              sp.y >= y &&
              sp.y <= y + bH
            ) {
              pri += itemPriority(sp);
              collectedSpawn.add(j);
            }
          }
        }
        return pri;
      };
      const catchScore = simScore(true);
      const skipScore = simScore(false);
      // 임계값: skip이 catch보다 K배 이상 이득일 때만 skip. 미묘한 차이는 catch 유지.
      // 근거: 시뮬-실제 궤도 오차로 봇 skip 후 실제 자연 수집 실패 케이스 다수 발생.
      // K=2로 사용자 케이스 (비율 20:1) 유지 + 부작용 케이스 (비율 1~2배) 제거.
      const SKIP_MARGIN_K = 2;
      if (skipScore > catchScore * SKIP_MARGIN_K && skipScore > catchScore + 3) {
        return { jump: false, slide: false, debugReason: "궤도 시뮬 대기" };
      }
    }

    // 수집 점프는 가까이 통과로 잡을 ground 효과·고가 코인이 있으면 미룬다
    if (protectGround) {
      return { jump: false, slide: false, debugReason: "지면 아이템 보호" };
    }

    // 점프하면 비행 trajectory 안 obstacle과 박스 겹침이 일어나는지 정밀 검사 (수집점프 한정).
    // (1) 비행 영역(flightEnd 이내) obstacle: 도달 시점 봇 y로 박스 겹침 정밀 검사 —
    //     봇 발이 obstacle 위 또는 머리가 obstacle 아래면 통과 가능, 차단 X.
    // (2) 비행 끝~회피 trigger 거리 사이 obstacle: ground 도달 후 봇이 회피 trigger
    //     발동할 거리 부족이면 충돌. 거리는 obstacle 높이별로 분기 — low는 단점프 회피,
    //     high는 단점프+이단점프 회피로 trigger 범위가 다름. 봇이 ground 도달 직후
    //     trigger MAX 안에 들어와야 즉시 발동 가능하므로 MAX 거리만큼 여유 확보.
    let blockingObstacleAhead = false;
    if (!lastingImmune) {
      for (let i = 0; i < visibleObs.length; i++) {
        const o = visibleObs[i]!;
        // 플랫폼은 world.ts 충돌 loop에서 제외되는 통과 가능 대상 — 봇 catch 점프
        // 후 자연 착지하거나 통과. 벽처럼 차단하면 아래 지면 아이템(코인/heal 등)을
        // 잡으려는 수집점프가 근처 플랫폼 때문에 발동 안 됨.
        if (o.kind === "platform") continue;
        const oYBottom = o.yBottom ?? 0;
        let triggerMaxSec: number;
        if (oYBottom === 0) {
          triggerMaxSec =
            o.height > highHeightLimit
              ? AVOID_HIGH_TRIGGER_MAX_SEC
              : AVOID_LOW_TRIGGER_MAX_SEC;
        } else {
          // 천장 obstacle은 슬라이드로 회피 — slide trigger 발동 거리.
          triggerMaxSec = SLIDE_TRIGGER_LOOKAHEAD_SEC;
        }
        const flightEndWithMargin = flightEnd + triggerMaxSec * effSpeed;
        if (o.x < r.x + r.baseWidth || o.x > flightEndWithMargin) continue;
        const oYTop = oYBottom + o.height;
        const isHighGround =
          oYBottom === 0 && o.height > highHeightLimit;

        if (o.x < flightEnd) {
          // (1) 비행 영역 안 — 봇이 obstacle x 범위를 통과하는 시간[tEnter, tExit] 동안
          // 경계(o.x == flightEnd)는 봇 ground 도달 직후 obstacle 진입 → (2) 분기에서 차단.
          //     봇 박스(y_min ~ y_max+baseHeight)가 obstacle 박스와 겹치는지 검사.
          //     입구만 검사하면 봇이 정점에서 통과 후 ground 도달 시점이 obstacle 안인 케이스 누락.
          const tEnter = Math.max(0, (o.x - r.baseWidth - r.x) / effSpeed);
          const tExit = Math.min(
            flightTime,
            (o.x + o.width - r.x) / effSpeed,
          );
          if (tEnter < tExit) {
            const tPeak = r.jumpVelocity / GRAVITY_ABS;
            // 봇 실제 y(r.y) 반영 — 플랫폼 위(r.y>0) 상태에서도 정확한 궤도.
            const yAt = (t: number) =>
              r.y + r.jumpVelocity * t - 0.5 * GRAVITY_ABS * t * t;
            // 봇이 obstacle 안에 있는 시간 동안 y의 최저·최고 값
            let yMin = Math.min(yAt(tEnter), yAt(tExit));
            let yMax = Math.max(yAt(tEnter), yAt(tExit));
            if (tPeak > tEnter && tPeak < tExit) {
              yMax = Math.max(yMax, yAt(tPeak));
            }
            // 봇 박스 [yMin, yMax+baseHeight] vs obstacle [oYBottom, oYTop] 겹침 검사.
            // 연속식 y 값이 이산 tick 시뮬 대비 borderline 몇 px 오차 (fix #14와 동일 패턴).
            // seed 1559855750 stage3-slides t=470 heal(g301,y180) 콤보 catch 발동 → 단점프
            //   궤도로 앞 L(h=30) 지나감. 연속식 yMin=31.45>30 통과 판정 → 실제 이산 t=508
            //   x=2540 y=22.2로 obstacle 우측 옆면 충돌. 오차 ~9px.
            // 안전 마진 10 — 그룹 A(오차 9) 커버. 마진 15는 seed 1565178987 t=491 궤도
            //   yMin=43.07 (실제 이산 45.2, 오차 2)를 false positive blocking → c5 catch
            //   놓치고 L에 그냥 부딪힘. 마진 10이 두 케이스 모두 정확 판정.
            const TRAJECTORY_SAFETY = 10;
            if (
              yMax + r.baseHeight > oYBottom &&
              yMin < oYTop + TRAJECTORY_SAFETY
            ) {
              // 단점프만으론 충돌. high ground obstacle은 정점 이단점프 보충으로
              // 안전 통과 가능한지 시뮬 — 가능하면 차단 X (봇은 정점에서 이단점프 trigger).
              if (isHighGround && canDoubleJumpClear(o.x, o.width, o.height)) {
                continue;
              }
              blockingObstacleAhead = true;
              break;
            }
          }
          // 안 겹침 — 통과 가능. 다음 obstacle.
        } else {
          // (2) 비행 끝 후 — ground 도달 후 회피 기회 판정.
          // 봇 landing 시 obstacle까지 gap = o.x - flightEnd. 봇 walking으로 gap 감소.
          // gap이 trigger MIN 이상이면 봇이 trigger zone 진입 시 avoid 발동 → 안전.
          // gap이 trigger MIN 미만이면 봇 이미 too-close → avoid 발동 안 함 → 충돌.
          if (oYBottom === 0) {
            const triggerMinSec = isHighGround
              ? AVOID_HIGH_TRIGGER_MIN_SEC
              : AVOID_LOW_TRIGGER_MIN_SEC;
            const safeGap = flightEnd + triggerMinSec * effSpeed;
            if (o.x >= safeGap) continue; // 봇 walking으로 avoid 여유 있음
            // high ground obstacle은 봇 정점 이단점프 보충으로 통과 가능하면 차단 X
            if (isHighGround && canDoubleJumpClear(o.x, o.width, o.height)) {
              continue;
            }
            blockingObstacleAhead = true;
            break;
          }
          // 천장 obstacle이 봇 baseHeight보다 낮게 걸려 (슬라이드 필요), 봇 landing x range가
          // obstacle x range와 겹치면 착지 즉시 옆면 충돌. 슬라이드 trigger는 다음 tick부터라 늦음.
          // world.ts 순서: 착지 판정 → 슬라이드 여부 갱신 → obstacle 충돌 검사. 착지 tick에 아직
          // input.slide 반영 전이라 body [0, baseHeight]로 충돌 검사됨.
          if (oYBottom < r.baseHeight) {
            const landingRight = flightEnd;
            const landingLeft = flightEnd - r.baseWidth;
            if (landingRight > o.x && landingLeft < o.x + o.width) {
              blockingObstacleAhead = true;
              break;
            }
          }
        }
      }
    }
    if (blockingObstacleAhead) {
      return { jump: false, slide: false, debugReason: "앞 장애물 차단" };
    }

    // 트리거 zone 안 catchable 후보가 있으면 점프 (priority는 위에서 catchableNowPri로 계산).
    // 수집점프 발동 전 착지 pit 검사 — 봇 단점프 착지 pit 안이면 발동 skip.
    // 이전엔 이단점프까지 사용해도 못 넘으면 skip이었으나, 이단점프 실제 발동은 별도 branch
    // 판단이라 확실치 않음. 안전 우선 원칙: 자연 착지 pit 안이면 수집점프 자체 skip.
    // 봇 walking 유지하면 지면 pit 회피 branch가 대응.
    if (catchableNowPri >= 0) {
      if (willLandInPit()) {
        return { jump: false, slide: false, debugReason: "수집점프 구멍차단" };
      }
      return { jump: true, slide: false, debugReason: "수집점프" };
    }
  } else if (r.jumpsLeft > 0) {
    const lastingImmuneAir = isLastingImmune(world);
    const highHeightLimit = singleJumpHeightLimit(world);
    // 비행 중에도 거대화 몸통 배율 반영 — 봇 판단이 실제 몸통과 일치하도록.
    const jbH = jumpBodyHeight(world);

    // 비행 중 구멍 회피 — 봇 ground 도달 예상 위치가 구멍 안이면 이단점프 발동.
    // 봇이 단점프 후 도달 지점이 구멍 안이면 떨어져 사망 — 추가 점프로 너머 도달.
    // lastingImmuneAir 조건 없음 — dash 중 비행도 pit 회피 필수.
    // dash 종료 예측 반영 (predictLandingX) — 봇 dash 활성 시 착지 낙관 예측 방지.
    {
      const yPos = r.y;
      const disc = r.vy * r.vy + 2 * GRAVITY_ABS * yPos;
      if (disc > 0) {
        const tLand = (r.vy + Math.sqrt(disc)) / GRAVITY_ABS;
        if (tLand > 0) {
          const landingLeft = predictLandingX(world, effSpeed, r.x, tLand);
          const landingRight = landingLeft + r.baseWidth;
          for (const pit of visiblePitList) {
            if (landingRight > pit.x && landingLeft < pit.x + pit.width) {
              // 적응형 이단점프 타이밍 — pit 검출 상황에서만 override.
              // 스코어러가 nop/airjump@k/aircombo 후보 시뮬 후 최고점 선택.
              // sim에서 착지 후 자연 회피 가능한 obstacle 충돌은 무시 (봇 실제 판단 반영).
              if (!lastingImmuneAir) {
                const timing = bestDoubleJumpTiming(world, effSpeed);
                if (timing.fire) {
                  return { jump: true, slide: false, debugReason: "이단점프 (적응형 pit)" };
                }
                if (!timing.noJump) {
                  return { jump: false, slide: false, debugReason: "이단점프 대기 (적응형 pit)" };
                }
              }
              // 이단점프해도 여전히 pit 안 착지(margin 0)면 발동 무효 — 사실상 낙사 확정.
              // 자연 낙하가 이미 pit 안 확정 상태이므로 safety margin 무시(useMargin=false).
              // 아슬아슬해도 이단점프로 pit 밖 착지 가능성이 있으면 발동이 이득.
              if (wouldLandInPitAfterDouble(world, effSpeed, false)) break;
              // 이단점프 궤도 안전 검사 — 앞 ground obstacle에 옆면 충돌 없는지.
              // Case A: 봇 궤도가 obstacle x 범위 통과 중 y >= obstacle top → 위로 넘김.
              // Case B: 봇 착지가 obstacle 앞이고 walking gap ≥ 회피 trigger MIN → 회피점프.
              // 둘 다 실패면 이단점프 발동 skip → 자연 낙하 유지 (pit 낙사 감수해도 옆면
              // 충돌보단 나은 경우 상당수 — 실제로 이단점프 궤도가 pit는 넘겨도 obstacle에
              // 옆면 충돌하는 케이스는 자연 낙하 시 pit 밖 착지 가능성 있음).
              // BugReport #3: seed 2053466398 tick 266 pit 회피 이단점프 → 착지 gap=62 <
              //   avoid_high MIN(80) → walking 회피 실패 → highGround 옆면 충돌 사망.
              const jv = r.jumpVelocity;
              const g = GRAVITY_ABS;
              const tLandAfterDj = (jv + Math.sqrt(jv * jv + 2 * g * yPos)) / g;
              const djLandingLeft = predictLandingX(
                world,
                effSpeed,
                r.x,
                tLandAfterDj,
              );
              const djLandingRight = djLandingLeft + r.baseWidth;
              const yAfterDj = (t: number): number =>
                yPos + jv * t - 0.5 * g * t * t;
              let obstacleBlocks = false;
              for (let i = 0; i < visibleObs.length; i++) {
                const o = visibleObs[i]!;
                if (o.kind === "platform") continue;
                if (o.x + o.width <= r.x + r.baseWidth) continue; // 이미 지난 obstacle
                const oYBottom = o.yBottom ?? 0;
                const oYTop = oYBottom + o.height;
                const tEnter = Math.max(
                  0,
                  (o.x - r.baseWidth - r.x) / effSpeed,
                );
                const tExit = (o.x + o.width - r.x) / effSpeed;
                if (oYBottom === 0) {
                  // 지면 obstacle — 봇 착지 gap 확보 or 궤도 위 통과.
                  const isHigh = o.height > highHeightLimit;
                  const trigMinSec = isHigh
                    ? AVOID_HIGH_TRIGGER_MIN_SEC
                    : AVOID_LOW_TRIGGER_MIN_SEC;
                  const safeGap = trigMinSec * effSpeed;
                  // Case B: 봇 착지가 obstacle 앞이고 gap 확보되면 안전.
                  if (djLandingRight + safeGap <= o.x) break;
                  // Case A: 봇 궤도로 obstacle x 범위 통과 중 y(발) >= obstacle top.
                  if (tExit > tEnter && tExit <= tLandAfterDj) {
                    const yMin = Math.min(yAfterDj(tEnter), yAfterDj(tExit));
                    if (yMin >= o.height) break;
                  }
                } else {
                  // 천장 obstacle — 봇 궤도가 obstacle 아래 통과(봇 몸통 top <= yBottom)이어야.
                  // 그렇지 않으면 이단점프 궤도로 옆면 충돌. 착지 후 슬라이드는 낙하 궤도상
                  // 이미 여기서 obstacle 진입 → 무효. BugReport #1: seed 776376923 tick 1241
                  //   pit 회피 이단점프 → 정점 214.7 → ceiling(y=30~120) 옆면 충돌 사망.
                  if (tExit > tEnter && tExit <= tLandAfterDj) {
                    // 정점이 통과 구간 안이면 y_max = 정점 y.
                    const tPeakDj = jv / g;
                    const yMax =
                      tPeakDj > tEnter && tPeakDj < tExit
                        ? yAfterDj(tPeakDj)
                        : Math.max(yAfterDj(tEnter), yAfterDj(tExit));
                    // 봇 몸통 top = y + baseHeight. yTop = ceiling top.
                    // 봇 몸통이 ceiling 아래 통과: yMax + baseHeight <= oYBottom.
                    // 봇 몸통이 ceiling 위 통과: y_min >= oYTop (거의 없는 케이스).
                    const yMin = Math.min(yAfterDj(tEnter), yAfterDj(tExit));
                    if (yMax + r.baseHeight <= oYBottom) break;
                    if (yMin >= oYTop) break;
                  }
                }
                obstacleBlocks = true;
                break; // 가장 가까운 앞 obstacle만 확인
              }
              if (obstacleBlocks) break;
              return { jump: true, slide: false, debugReason: "구멍 회피 비행중" };
            }
          }
        }
      }
    }

    // 이단점프 — 높은 장애물 회피. 떨어지는 중(vy<=0) trigger zone 정렬 가정.
    // 지속 면역만 skip (잔여 무적은 곧 끝나니 회피 필요).
    if (r.vy <= 0 && !lastingImmuneAir) {
      // 이단점프 회피는 정점에서 다음 장애물 위치 판단 — effective 속도 기준 시간.
      const doubleMin = DOUBLE_JUMP_TRIGGER_MIN_SEC * effSpeed;
      const doubleMax = DOUBLE_JUMP_TRIGGER_MAX_SEC * effSpeed;
      for (let i = 0; i < visibleObs.length; i++) {
        const o = visibleObs[i]!;
        const oYBottom = o.yBottom ?? 0;
        if (oYBottom > 0) continue;
        if (o.height <= highHeightLimit) continue;
        const gap = o.x - (r.x + r.width);
        if (gap < 0) continue;
        if (gap >= doubleMin && gap <= doubleMax) {
          if (wouldLandInPitAfterDouble(world, effSpeed)) break; // pit 낙사 방지
          return { jump: true, slide: false, debugReason: "이단점프 높은장애물" };
        }
      }
    }

    // 이단점프 보충 판정 — 봇 단점프 궤도가 지상 obstacle 옆면 충돌 예상이면,
    // supplementary trajectory 시뮬로 안전 통과 가능한지 검사하고 발동.
    // high(h=150)뿐 아니라 low(h=30)도 검사 — 봇이 이단점프 후 하강 중 앞 L 인지해도
    // trajectorySafe(r.vy) 옆면 판정 시 이단점프 발동해서 안전 통과.
    // 케이스: seed 1565178987/660555840/1982340607/1843602865 (봇 정점 지난 후 하강 중
    //   앞 L 옆면 예상되지만 기존 branch가 highHeightLimit 이하 skip → 봇 walking 착지 후
    //   L 옆면 30 데미지).
    // 기존엔 `|vy|<=200` gate로 발동 시점 제한 → 신발×3(속도 400) 케이스는 봇이 vy≤200 진입
    // 시점(t=298)에 이미 obstacle 앞 18px, 보충해도 3틱 안 못 넘음. 원인: 빠른 봇은 vy 높을 때
    // 미리 보충해야 obstacle 도달 전 충분한 y 확보 가능. 해결: vy gate 제거 + "단점프 궤도만으론
    // 충돌 예상" pre-check로 필요한 시점에만 발동.
    // **충돌 검사는 step별 이산 시뮬 (연속식은 borderline 0.5~2px 오차로 통과 판정 후
    // 실제로는 충돌하는 케이스 있음 — 시드 20 사례)**.
    if (!lastingImmuneAir) {
      const dt = TICK_DURATION;
      const advancePerStep = effSpeed * dt;
      // 봇이 obstacle 옆면과 step별 겹침 검사 헬퍼. initVy로 시작 vy 지정.
      // vy=r.vy → 단점프 궤도 그대로. vy=jumpVelocity → supplementary 즉시 발동 후 궤도.
      const trajectorySafe = (
        oX: number,
        oWidth: number,
        oHeight: number,
        initVy: number,
      ): boolean => {
        if (advancePerStep <= 0) return false;
        let y = r.y;
        let vy = initVy;
        let x = r.x;
        const oRight = oX + oWidth;
        for (let s = 0; s < 200; s++) {
          vy -= GRAVITY_ABS * dt;
          y += vy * dt;
          x += advancePerStep;
          if (y < 0) y = 0;
          const botRight = x + r.baseWidth;
          if (botRight > oX && x < oRight) {
            if (y < oHeight) return false;
          }
          if (x >= oRight) return true;
        }
        return false;
      };
      // 트랙 끝 근접 시 낮은 벽 대상 이단점프 보충 skip — 봇 발판 walkoff 시나리오에서
      // 새 트랙 진입 궤도가 크게 바뀌어 wrap 이후 첫 장애물 대응 실패 유발 (seed 2066557580 사례).
      // 높은 벽(h>105)은 안 넘으면 사망 위험 크므로 트랙 끝 근처여도 유지.
      const nearTrackEnd = r.x > world.currentTrack.length - 400;
      for (let i = 0; i < visibleObs.length; i++) {
        const o = visibleObs[i]!;
        const oYBottom = o.yBottom ?? 0;
        if (oYBottom > 0) continue;
        if (o.kind === "platform") continue;
        const isLow = o.height <= highHeightLimit;
        // 낮은 벽 + 트랙 끝 근접 → skip. 회귀 방지.
        if (isLow && nearTrackEnd) continue;
        const tEnter = (o.x - r.baseWidth - r.x) / effSpeed;
        if (tEnter <= 0) continue;
        // 봇 현재 궤도(단점프 그대로)가 obstacle 옆면 충돌 예상이고, supplementary trajectory는
        // 안전 통과 가능하면 발동. 단점프로 이미 안전하면 보충 불필요 — 발동 skip으로 남은
        // 점프 아껴 다음 obstacle 대응.
        if (trajectorySafe(o.x, o.width, o.height, r.vy)) continue;
        if (trajectorySafe(o.x, o.width, o.height, r.jumpVelocity)) {
          if (wouldLandInPitAfterDouble(world, effSpeed)) break; // pit 낙사 방지
          return { jump: true, slide: false, debugReason: "정점 보충" };
        }
      }
    }

    // === 회피용 이단점프 — 단점프 trajectory가 high obstacle과 충돌하는 케이스 ===
    // 봇이 정점 도달 후(vy<=0)에 봇이 이미 obstacle 좌측 안(gap<0)으로 들어간 케이스 보완.
    // 기존 회피 분기(line 458)는 gap>=0만 검사라 봇 비행거리가 obstacle까지 거리보다 길어
    // 봇 정점이 obstacle 안일 때 발동 못 함.
    // 정점 전(vy>0) 발동은 일반적으로 막음 — 너무 일찍 이단점프하면 단점프 + 이단점프 정점이
    // 거의 같은 시점이라 obstacle 우측 통과 시점에 빨리 떨어져서 옆면 충돌함 (시드 1926305692 사례).
    // 예외: 봇 정점 도달 후 이단점프 발동 시 pit 안 착지 예상(wouldLandAtApexInPit)이면
    // 정점 딜레마 — 상승 중에도 이른 시점 이단점프 검사 허용. 옆면 충돌 위험 감수하되
    // pit 즉사보다 나음. 봇 상승 중 매 tick 검사로 obstacle 안전 통과 가능한 최적 시점 자연 도달.
    const apexTrap = r.vy > 0 && wouldLandAtApexInPit(world, effSpeed);
    if ((r.vy <= 0 || apexTrap) && !lastingImmuneAir) {
      // 봇 단점프 그대로 진행 시 착지까지 시간
      const tLandSingle =
        (r.vy + Math.sqrt(r.vy * r.vy + 2 * GRAVITY_ABS * r.y)) / GRAVITY_ABS;
      const flightEndSingle = r.x + r.baseWidth + effSpeed * tLandSingle;
      // 단점프 trajectory의 t 시점 봇 발 y (지금이 t=0)
      const yAtSingle = (t: number): number =>
        r.y + r.vy * t - 0.5 * GRAVITY_ABS * t * t;

      for (let i = 0; i < visibleObs.length; i++) {
        const o = visibleObs[i]!;
        const oYBottom = o.yBottom ?? 0;
        if (oYBottom > 0) continue; // 지상 장애물만 (천장은 슬라이드 영역)
        if (o.height <= highHeightLimit) continue; // 단점프로 넘는 낮은 장애물은 제외
        // 이미 봇 좌측 너머 통과한 장애물은 무시
        if (o.x + o.width < r.x) continue;
        // 비행 끝 너머 장애물은 다른 분기(지상 회피)에서 처리
        if (o.x > flightEndSingle) continue;

        // 봇 박스가 장애물 x 범위에 겹치는 시간 [tEnter, tExit]
        // 봇이 이미 장애물 안이면 tEnter는 음수 가능 → 0으로 클램프
        const tEnter = Math.max(0, (o.x - r.baseWidth - r.x) / effSpeed);
        const tExit = Math.min(tLandSingle, (o.x + o.width - r.x) / effSpeed);
        if (tEnter >= tExit) continue;

        // 단점프 trajectory가 장애물 위로 안전 통과하는지 — 구간 양 끝에서 봇 발이
        // 장애물 머리 위라야 안전. 정점은 max라 min은 양 끝 중 하나.
        const yMinSingle = Math.min(yAtSingle(tEnter), yAtSingle(tExit));
        if (yMinSingle >= o.height) continue; // 단점프로 안전 통과 — 발동 X

        // 이단점프 즉시 발동 시 obs 겹침 구간의 실제 최저 y를 60Hz 이산 sim으로 계산.
        // 연속시간 공식(y = y0 + v0·t − ½g·t²)은 world.step의 Euler forward 이산 시뮬과
        // 차이가 커서 실측보다 정점 y를 높게 예측 → 옆면 충돌 놓침.
        let yMinDouble = Infinity;
        let simY = r.y;
        let simVy = r.jumpVelocity;
        let simX = r.x;
        const simStep = effSpeed * TICK_DURATION;
        const oRight = o.x + o.width;
        for (let st = 0; st < 200; st++) {
          simVy -= GRAVITY_ABS * TICK_DURATION;
          simY += simVy * TICK_DURATION;
          simX += simStep;
          if (simY <= 0) break;
          if (simX + r.baseWidth > o.x && simX < oRight) {
            if (simY < yMinDouble) yMinDouble = simY;
          } else if (simX >= oRight) {
            break;
          }
        }
        if (yMinDouble >= o.height + SINGLE_JUMP_SAFETY_MARGIN) {
          // apexTrap(봇 상승 중 정점 딜레마)일 땐 지금 봇 y 낮아서 wouldLandInPitAfterDouble
          // 대체로 false — 즉시 발동으로 pit 앞 착지. 하강 중(정상)에만 pit skip 검사.
          if (!apexTrap && wouldLandInPitAfterDouble(world, effSpeed)) break;
          return {
            jump: true,
            slide: false,
            debugReason: apexTrap ? "이단점프 이른발동 구멍" : "정점 안전 높은장애물",
          };
        }
        // 이단점프해도 못 넘으면 어쩔 수 없음 — 다음 장애물 검사로
      }
    }

    // 이단점프 — 상승 중(vy>0) 보충 수집. 지연 timing 후보 [0,5,10,15,20] 각각 물리 공식으로
    // 계산해서 어느 timing에 이단점프 발동하면 아이템 총 가치 최대인지 선택.
    // 지금(0) 최고면 발동, 지연 최고면 대기 (다음 tick 재판정으로 delay 자연 감소 → 발동 도달).
    // 발동 안 함 (r.vy로 계속 진행)이 최고면 다음 분기로.
    // 케이스: seed 158120043 (1183.5, 80) 단점프 catch 후 (1215.5, 180) v=20 보충.
    // 케이스: seed 57868 t165 봇 vy=640 상승 조기 발동 → 콤보 정점 낮음 개선 목표.
    if (r.vy > 0 && !lastingImmuneAir) {
      const advancePerStep = effSpeed * TICK_DURATION;
      const dt = TICK_DURATION;
      const DELAY_CANDIDATES = [0, 5, 10, 15, 20];
      // 지연 tick 후 이단점프 발동 시 아이템 잡히나 (step-by-step 이산 시뮬).
      // 지연 동안 봇 자연 상승/하강 계속, 지연 시점에 vy 재설정.
      const canCatchWithDelay = (
        delayTicks: number,
        itemX: number,
        itemY: number,
      ): boolean => {
        if (advancePerStep <= 0) return false;
        const mStart = Math.max(
          1,
          Math.ceil((itemX - r.baseWidth - r.x) / advancePerStep),
        );
        const mEnd = Math.floor((itemX - r.x) / advancePerStep);
        if (mEnd < mStart) return false;
        let y = r.y;
        let vy = r.vy;
        for (let m = 1; m <= mEnd; m++) {
          if (m === delayTicks + 1) vy = r.jumpVelocity; // 지연 시점 이단점프 발동
          vy -= GRAVITY_ABS * dt;
          y += vy * dt;
          if (y < 0) return false; // 착지
          if (m >= mStart && itemY >= y && itemY <= y + r.baseHeight) return true;
        }
        return false;
      };
      // 이단점프 안 함 (r.vy로 계속 진행) 시 잡히나 = 기존 singleSumPri.
      const canCatchNoJump = (itemX: number, itemY: number): boolean => {
        if (advancePerStep <= 0) return false;
        const mStart = Math.max(
          1,
          Math.ceil((itemX - r.baseWidth - r.x) / advancePerStep),
        );
        const mEnd = Math.floor((itemX - r.x) / advancePerStep);
        if (mEnd < mStart) return false;
        let y = r.y;
        let vy = r.vy;
        for (let m = 1; m <= mEnd; m++) {
          vy -= GRAVITY_ABS * dt;
          y += vy * dt;
          if (y < 0) return false;
          if (m >= mStart && itemY >= y && itemY <= y + r.baseHeight) return true;
        }
        return false;
      };
      // 상승 중 보충 대상: 부작용 적은 아이템.
      // v≥5 코인 / heal / magnet. dash·giant는 immune state cascade로
      // protectGround 범위 확장 → 다른 catch 손해 (케이스: seed 158120043 dash spawn).
      const isValuableAir = (item: {
        value?: number;
        effect?: import("./stage").ItemEffect;
      }): boolean => {
        if (item.effect === "dash" || item.effect === "giant") return false;
        if (item.effect) return true;
        return (item.value ?? 1) >= 5;
      };
      let noJumpSumPri = 0;
      const delayedSumPri = new Array<number>(DELAY_CANDIDATES.length).fill(0);
      for (let i = 0; i < world.currentTrack.items.length; i++) {
        if (world.currentItemCollected[i]) continue;
        const item = world.currentTrack.items[i]!;
        if (!isValuableAir(item)) continue;
        if (item.x <= r.x) continue;
        const pri = itemPriority(item);
        if (canCatchNoJump(item.x, item.y)) noJumpSumPri += pri;
        for (let k = 0; k < DELAY_CANDIDATES.length; k++) {
          if (canCatchWithDelay(DELAY_CANDIDATES[k]!, item.x, item.y)) {
            delayedSumPri[k]! += pri;
          }
        }
      }
      for (const sp of world.spawnedItems) {
        if (sp.collected) continue;
        if (!isValuableAir(sp)) continue;
        if (sp.x <= r.x) continue;
        const pri = itemPriority(sp);
        if (canCatchNoJump(sp.x, sp.y)) noJumpSumPri += pri;
        for (let k = 0; k < DELAY_CANDIDATES.length; k++) {
          if (canCatchWithDelay(DELAY_CANDIDATES[k]!, sp.x, sp.y)) {
            delayedSumPri[k]! += pri;
          }
        }
      }
      // 지연 후보 중 최고점 선택 (tie 시 이른 timing 우선 — bestK 초기값 0 유지)
      let bestK = 0;
      let bestScore = delayedSumPri[0]!;
      for (let k = 1; k < DELAY_CANDIDATES.length; k++) {
        if (delayedSumPri[k]! > bestScore) {
          bestScore = delayedSumPri[k]!;
          bestK = k;
        }
      }
      // 이단점프 최고점이 발동 안 함보다 확실히 유리해야 이단점프 시나리오 채택.
      if (bestScore > noJumpSumPri) {
        // 최고점 timing이 지연이면 대기 (다음 tick 재판정으로 delayTicks 자연 감소 → 발동).
        if (DELAY_CANDIDATES[bestK]! > 0) {
          return { jump: false, slide: false, debugReason: "비행중 상승 수집 대기" };
        }
        // 최고점 timing = 0 → 지금 발동. 이단점프 후 obstacle/pit 안전 검사.
        const apexAfter = r.y + (r.jumpVelocity * r.jumpVelocity) / (2 * GRAVITY_ABS);
        const totalAirAfter =
          r.jumpVelocity / GRAVITY_ABS + Math.sqrt((2 * apexAfter) / GRAVITY_ABS);
        const flightLandEndAfter = r.x + r.baseWidth + effSpeed * totalAirAfter;
        const apexHeadAfter = apexAfter + r.baseHeight;
        // 이단점프 후 봇 착지 예상 위치가 pit 안이면 skip — 큰 코인 욕심에 pit 낙사 방지.
        // 케이스: 신발×3+0 seed 718487486 t2579 c20*(y=210) 잡으려 이단점프 → 정점 232 → pit 안 착지.
        let blockAir = wouldLandInPitAfterDouble(world, effSpeed);
        for (let i = 0; !blockAir && i < visibleObs.length; i++) {
          const o = visibleObs[i]!;
          // 플랫폼은 통과 가능(위 착지만 유효, 옆·아래 충돌 없음) — 차단 X.
          if (o.kind === "platform") continue;
          const oYBottom = o.yBottom ?? 0;
          const triggerMinSec =
            oYBottom > 0
              ? SLIDE_TRIGGER_LOOKAHEAD_SEC
              : o.height > highHeightLimit
                ? AVOID_HIGH_TRIGGER_MIN_SEC
                : AVOID_LOW_TRIGGER_MIN_SEC;
          const flightEndForObs = flightLandEndAfter + triggerMinSec * effSpeed;
          if (o.x < r.x + r.baseWidth || o.x > flightEndForObs) continue;
          if (oYBottom === 0) {
            // low obstacle이면 이단점프 궤도 안전 통과(위로 넘거나 착지 후 회피 gap 확보) 시 통과 허용.
            if (
              o.height <= highHeightLimit &&
              doubleJumpClearsLowObs(world, o.x, o.width, o.height, effSpeed)
            ) {
              continue;
            }
            blockAir = true;
            break;
          }
          if (apexHeadAfter > oYBottom) {
            blockAir = true;
            break;
          }
        }
        if (!blockAir)
          return { jump: true, slide: false, debugReason: "비행중 상승 수집" };
      }
    }

    // 이단점프 — 떨어지는 중에 머리 위 코인 보충 수집 (수집은 픽셀 상수 유지)
    if (r.vy < -100) {
      // 이단점프 후 ground 도달 위치에 obstacle 있으면 trigger 보류 —
      // 점프해도 ground에 obstacle 위로 떨어져 충돌함.
      const apex = r.y + (r.jumpVelocity * r.jumpVelocity) / (2 * GRAVITY_ABS);
      const totalAirTime =
        r.jumpVelocity / GRAVITY_ABS + Math.sqrt((2 * apex) / GRAVITY_ABS);
      const flightEndAir =
        r.x +
        r.baseWidth +
        effSpeed * totalAirTime +
        AVOID_HIGH_TRIGGER_MIN_SEC * effSpeed;
      const simStep = effSpeed * TICK_DURATION;
      let blockAir = false;
      let evasionJump = false;
      if (!lastingImmuneAir) {
        for (let i = 0; i < visibleObs.length; i++) {
          const o = visibleObs[i]!;
          // 플랫폼은 통과 가능(위 착지만 유효) — 차단 X.
          if (o.kind === "platform") continue;
          if (o.x < r.x + r.baseWidth || o.x > flightEndAir) continue;
          const oYBottom = o.yBottom ?? 0;
          if (oYBottom === 0) {
            // low obstacle이면 이단점프 궤도 안전 통과 시 통과 허용 (case 완화).
            if (
              o.height <= highHeightLimit &&
              doubleJumpClearsLowObs(world, o.x, o.width, o.height, effSpeed)
            ) {
              continue;
            }
            blockAir = true;
            break;
          }
          // 천장 obstacle — 이산 sim으로 이단점프/자연 궤적 정밀 판정.
          // 이단점프 궤적이 obs 겹침 구간에서 봇 발 y가 지붕(oTop) 이상이면 안전 통과.
          // 봇 자연 궤적이 obs.y 범위에 봇 몸이 걸친 상태로 진입하면 옆면 충돌 예정.
          // 자연 진입 예정 + 이단점프 안전 통과 가능이면 회피 이단점프 발동.
          const oTop = oYBottom + o.height;
          const oRight = o.x + o.width;
          let doubleSafe = true;
          {
            let sy = r.y;
            let svy = r.jumpVelocity;
            let sx = r.x;
            let seenOverlap = false;
            for (let st = 0; st < 200; st++) {
              svy -= GRAVITY_ABS * TICK_DURATION;
              sy += svy * TICK_DURATION;
              sx += simStep;
              if (sy <= 0) break;
              if (sx + r.baseWidth > o.x && sx < oRight) {
                seenOverlap = true;
                if (sy < oTop) {
                  doubleSafe = false;
                  break;
                }
              } else if (sx >= oRight) break;
            }
            if (!seenOverlap) doubleSafe = false;
          }
          let naturalHits = false;
          {
            let sy = r.y;
            let svy = r.vy;
            let sx = r.x;
            for (let st = 0; st < 200; st++) {
              svy -= GRAVITY_ABS * TICK_DURATION;
              sy += svy * TICK_DURATION;
              sx += simStep;
              if (sy < 0) sy = 0; // 착지 후 walking 상태로도 obs 옆면 진입 감지
              if (sx + r.baseWidth > o.x && sx < oRight) {
                if (sy < oTop && sy + r.baseHeight > oYBottom) {
                  naturalHits = true;
                  break;
                }
              } else if (sx >= oRight) break;
            }
          }
          if (naturalHits && doubleSafe) {
            if (!wouldLandInPitAfterDouble(world, effSpeed)) {
              evasionJump = true;
              break;
            }
            blockAir = true;
            break;
          }
          if (naturalHits) {
            blockAir = true;
            break;
          }
          // 자연 궤적 안전 → 이단점프 안 해도 이 obs 문제 없음. 다음 obs 검사.
        }
      }
      if (evasionJump) {
        return { jump: true, slide: false, debugReason: "비행중 하강 회피" };
      }
      if (blockAir) {
        return { jump: false, slide: false, debugReason: "비행중 장애물 차단" };
      }

      // 이단점프 발동 후 코인 도달 시점에 캐릭터 박스가 코인 y를 덮는지 정밀 검사.
      // 단순히 gap 안 + y 위라고 trigger하면 떨어진 시점에 발동해서 정점이 너무 늦어 못 잡음.
      const canCatch = (itemX: number, itemY: number): boolean => {
        if (effSpeed <= 0) return false;
        const t = (itemX - r.x) / effSpeed;
        if (t <= 0) return false;
        const yAtT =
          r.y + r.jumpVelocity * t - 0.5 * GRAVITY_ABS * t * t;
        if (yAtT < 0) return false; // 코인 도달 전 ground 착지
        return itemY >= yAtT && itemY <= yAtT + jbH;
      };

      // 이단점프 보충은 가치 있는 후보(effect 또는 v≥5)에 한정.
      // 가치 1 코인 잡으려 이단점프하면 너무 높이 떠서 비행 중 회복·자석 같은
      // 큰 가치 아이템을 통과로 못 잡는 손해.
      const isValuable = (item: {
        value?: number;
        effect?: import("./stage").ItemEffect;
      }): boolean => !!item.effect || (item.value ?? 1) >= 5;

      let bestPri = -1;
      for (let i = 0; i < world.currentTrack.items.length; i++) {
        if (world.currentItemCollected[i]) continue;
        const item = world.currentTrack.items[i]!;
        if (!isValuable(item)) continue;
        if (item.y <= jbH) continue;
        if (item.y <= r.y + jbH) continue;
        const gap = item.x - r.x;
        if (gap < jumpTriggerMin || gap > jumpTriggerMax) continue;
        if (!canCatch(item.x, item.y)) continue;
        const pri = itemPriority(item);
        if (pri > bestPri) bestPri = pri;
      }
      for (const sp of world.spawnedItems) {
        if (sp.collected) continue;
        if (!isValuable(sp)) continue;
        if (sp.y <= jbH) continue;
        if (sp.y <= r.y + jbH) continue;
        const gap = sp.x - r.x;
        if (gap < jumpTriggerMin || gap > jumpTriggerMax) continue;
        if (!canCatch(sp.x, sp.y)) continue;
        const pri = itemPriority(sp);
        if (pri > bestPri) bestPri = pri;
      }
      if (bestPri >= 0) {
        // 봇이 이단점프 보충 안 하고 단점프 끝까지 가서 ground 도달하면 그 위치에서
        // 단점프로 잡을 더 가치 큰 후보 있나? 있으면 보충 X — 가치 큰 거 우선.
        // 케이스: seed 1189635507 t315 (1606,150) dash(100) 잡으러 이단점프 보충 →
        // 비행 길어져 (1684.5,120) magnet(1500) 미스. 단점프만 했으면 magnet 잡힘.
        const singleJumpLandX =
          r.x + (effSpeed * (r.jumpVelocity + r.vy)) / GRAVITY_ABS;
        const singleJumpReach =
          (r.jumpVelocity * r.jumpVelocity) / (2 * GRAVITY_ABS) + jbH;
        const canCatchFromGround = (itemX: number, itemY: number): boolean => {
          for (let g = jumpTriggerMin; g <= jumpTriggerMax; g += 5) {
            const t = g / effSpeed;
            const yAt =
              r.jumpVelocity * t - 0.5 * GRAVITY_ABS * t * t;
            if (yAt < 0) continue;
            if (itemY >= yAt && itemY <= yAt + jbH) {
              // 봇 진행 후 trigger 가능 시점 봇.x 위치 검사
              const triggerX = itemX - g;
              if (triggerX >= singleJumpLandX) return true;
            }
          }
          return false;
        };
        let landingFuturePri = 0;
        const considerLanding = (
          itemX: number,
          itemY: number,
          value: number | undefined,
          effect: import("./stage").ItemEffect | undefined,
        ): void => {
          if (!effect && (value ?? 1) < 5) return;
          if (itemY <= jbH) return;
          if (itemY > singleJumpReach) return;
          if (!canCatchFromGround(itemX, itemY)) return;
          const pri = itemPriority({ value, effect } as Item);
          if (pri > landingFuturePri) landingFuturePri = pri;
        };
        for (let i = 0; i < world.currentTrack.items.length; i++) {
          if (world.currentItemCollected[i]) continue;
          const it = world.currentTrack.items[i]!;
          considerLanding(it.x, it.y, it.value, it.effect);
        }
        for (const sp of world.spawnedItems) {
          if (sp.collected) continue;
          considerLanding(sp.x, sp.y, sp.value, sp.effect);
        }
        if (landingFuturePri > bestPri) {
          return { jump: false, slide: false, debugReason: "비행중 착지후 우선" };
        }
        if (wouldLandInPitAfterDouble(world, effSpeed)) {
          // 이단점프하면 pit 낙사 — 큰 코인 욕심 skip. 봇은 그대로 낙하 후 지면 판단.
        } else {
          return { jump: true, slide: false, debugReason: "비행중 하강 수집" };
        }
      }
    }
  }

  // === 비행 중 점프 예약 ===
  // 봇이 비행 중인데 곧 착지 예정 + 다음 ground obstacle이 봇 착지 시점 회피 trigger zone에
  // 들어올 거면 pendingJump=true. step에서 봇이 착지되는 그 tick에 단점프 즉시 발동.
  // 케이스: 봇이 이단점프 회피 직후 highGround 만남. 봇이 trigger zone 진입할 때는 비행 중,
  // 비행 끝 다음 tick에는 trigger zone 통과 → 회피 실패. pendingJump로 1 tick 오차 해소.
  // **tLand 제한**: 봇 정점(vy=0)부터 예약 결정 유지하면 봇이 비행 중 다른 회피 기회 놓침
  // (시드 1978310167: 봇 정점에서 낮은 장애물용 예약 → 28틱 유지 → 착지 자동 단점프 →
  // 그 비행 중 다음 높은 장애물 회피 기회 놓침 → 충돌). 봇이 진짜 곧 착지(5틱 이내)일 때만 예약.
  const PENDING_JUMP_MAX_TLAND = 5 * TICK_DURATION;
  if (!r.onGround && r.vy <= 0) {
    const yPos = r.y;
    const tLand = (r.vy + Math.sqrt(r.vy * r.vy + 2 * GRAVITY_ABS * yPos)) / GRAVITY_ABS;
    if (tLand > 0 && tLand <= PENDING_JUMP_MAX_TLAND) {
      const effSpeedNow = currentEffectiveSpeed(world);
      const landingRight = r.x + r.baseWidth + effSpeedNow * tLand;
      const highHeightLimit = singleJumpHeightLimit(world);
      const avoidLowMin = AVOID_LOW_TRIGGER_MIN_SEC * effSpeedNow;
      const avoidLowMax = AVOID_LOW_TRIGGER_MAX_SEC * effSpeedNow;
      const avoidHighMin = AVOID_HIGH_TRIGGER_MIN_SEC * effSpeedNow;
      const avoidHighMax = AVOID_HIGH_TRIGGER_MAX_SEC * effSpeedNow;
      // 예약 점프 후 새 flight 착지 예상 위치 계산 — pit 안 착지 예상되면 예약 skip.
      // 신발×3 pit 사망 다수 케이스: 봇 정상 착지 후 예약 점프 발동 → 새 flight로 pit 안 착지 낙사.
      // dash cooldown 자동 활성 반영해서 실제 이동 거리 예측.
      const jumpFlightTime = (2 * r.jumpVelocity) / GRAVITY_ABS;
      const afterJumpLandX = predictLandingX(
        world,
        effSpeedNow,
        landingRight - r.baseWidth,
        jumpFlightTime,
      );
      const afterJumpLandRight = afterJumpLandX + r.baseWidth;
      let landsInPit = false;
      for (const pit of visiblePitList) {
        if (afterJumpLandRight > pit.x && afterJumpLandX < pit.x + pit.width) {
          landsInPit = true;
          break;
        }
      }
      if (landsInPit) {
        // 예약 skip — 봇 정상 착지 후 지면 branch가 pit 회피 판단.
        return { jump: false, slide: false, debugReason: "대기" };
      }
      for (let i = 0; i < visibleObs.length; i++) {
        const o = visibleObs[i]!;
        if ((o.yBottom ?? 0) > 0) continue; // ground obstacle만 (ceiling은 슬라이드 분기)
        const gap = o.x - landingRight;
        if (gap < 0) continue;
        const isHigh = o.height > highHeightLimit;
        const min = isHigh ? avoidHighMin : avoidLowMin;
        const max = isHigh ? avoidHighMax : avoidLowMax;
        if (gap >= min && gap <= max) {
          return {
            jump: false,
            slide: false,
            pendingJump: true,
            debugReason: "점프 예약",
          };
        }
      }
    }
  }

  return { jump: false, slide: false, debugReason: "대기" };
}
