import { Rng } from "./rng";
import {
  Stage,
  Item,
  Obstacle,
  Pit,
  RandomDropKind,
  RandomObstacleKind,
  RandomTrackKind,
  DEFAULT_Y_SLOTS,
  TRACK_SAFE_PREFIX,
  DEFAULT_TRACK_BASE_SPEED,
} from "./stage";
import { Loadout, effectiveStats } from "./spec";
import {
  SkillState,
  createSkillState,
  tickSkill,
  aggregateSkillModifiers,
} from "./skill";

export const TICK_DURATION = 1 / 60; // 1틱 = 1/60초
const GRAVITY = -2200;

const TIME_DAMAGE_PER_SEC = 5;
const OBSTACLE_DAMAGE = 30;
const INVINCIBLE_TICKS = Math.round(1 / TICK_DURATION);
const POST_BUFF_INVINCIBLE_TICKS = Math.round(2 / TICK_DURATION); // dash·itemDash·거대화 종료 후 2초 추가 무적

// 효과 아이템 상수
const MAGNET_RANGE = 250; // 자석 흡수 반경 (픽셀)
const MAGNET_DURATION_TICKS = Math.round(5 / TICK_DURATION); // 자석 5초
const GIANT_DURATION_TICKS = Math.round(5 / TICK_DURATION); // 거대화 5초
const GIANT_SCALE = 2; // 거대화 시 캐릭터 크기 배율
const HEAL_AMOUNT = 10; // 회복량
// dash 효과 아이템 fallback: dash 스킬 없는 캐릭이 dash 아이템 먹었을 때 itemDashTicks에 직접 buff
const DASH_ITEM_FALLBACK_TICKS = Math.round(3 / TICK_DURATION);
// coinSpray 상수 — 3초 동안 봇 50px 이동마다 전방에 코인 3개 소환.
const COIN_SPRAY_DURATION_TICKS = Math.round(3 / TICK_DURATION);
const COIN_SPRAY_TRIGGER_DIST = 50; // 봇 x 누적 이동 이 값마다 트리거 1회
const COIN_SPRAY_COUNT = 3; // 트리거당 소환 코인 수
const COIN_SPRAY_LEAD_MIN_SEC = 0.3; // 봇 앞 소환 lead (봇 도달 시간)
const COIN_SPRAY_LEAD_MAX_SEC = 0.6;
const COIN_SPRAY_Y_MIN = 0;
const COIN_SPRAY_Y_MAX = 180;
// coinBoost 상수 — 3초 동안 맵의 v=1 코인을 v=5로 변환. 원복 없음.
const COIN_BOOST_DURATION_TICKS = Math.round(3 / TICK_DURATION);

// 파괴자 펫 상수
const DESTROYER_MIN_DISTANCE = 400; // 이보다 가까운 장애물은 무시 (발 아래 spawn 방지)
const DESTROYER_FORWARD_RANGE = 2000; // 전방 탐지 범위 (픽셀)

export interface Runner {
  x: number; // 현재 트랙 내 좌표 (0 ~ currentTrack.length)
  y: number;
  vy: number;
  baseRunSpeed: number;
  jumpVelocity: number;
  width: number; // 현재 effective width (거대화 시 baseWidth*GIANT_SCALE)
  height: number; // 현재 effective height (슬라이드 또는 거대화에 따라 변동)
  baseWidth: number;
  baseHeight: number;
  slideHeight: number;
  sliding: boolean;
  onGround: boolean;
  alive: boolean;
  hp: number;
  maxHp: number;
  invincibleTicks: number;
  jumpsLeft: number;
  maxJumps: number;
  magnetTicks: number; // 자석 활성 남은 ticks
  giantTicks: number; // 거대화 활성 남은 ticks
  itemDashTicks: number; // 장비 healDash 효과로 활성된 dash buff 남은 ticks (스킬 dash와 별개)
  coinSprayTicks: number; // coinSpray 활성 남은 ticks
  coinSpraySpawnAcc: number; // coinSpray 트리거용 누적 이동 거리 (COIN_SPRAY_TRIGGER_DIST마다 소환)
  coinBoostTicks: number; // coinBoost 활성 남은 ticks (지속 동안 새 v=1 스폰도 5로 변환)
  // 장비 스탯 (사이클 시작 시 effectiveStats로 세팅. 사이클 동안 불변).
  itemDurationMult: number; // 아이템·스킬 지속시간 곱 배율
  healAmountMult: number; // heal 아이템 회복량 곱 배율
  healSpeedBoostPct: number; // heal 획득 1회당 이동속도 배율 추가량 (0.01=+1%)
  // heal 누적 이동속도 보너스 (사이클 시작 시 1.0. heal 획득 시 healSpeedBoostPct 누적).
  healSpeedBonusMult: number;
  coins: number;
  totalDistance: number;
  lap: number;
  // 캐릭터 coinPerDistance 패시브의 마지막 적립 기준 distance.
  // step()에서 totalDistance와 비교해 차이가 coinPerDistance 단위로 누적되면 코인 적립.
  coinPassiveAnchor: number;
}

// 펫·스킬에 의해 동적으로 생성된 아이템 (트랙 정적 데이터와 별개)
export interface SpawnedItem {
  x: number;
  y: number;
  value?: number;
  effect?: import("./stage").ItemEffect;
  collected: boolean;
}

// step 동안 obstacle 충돌이 일어났는지 외부에서 감지하기 위한 신호.
// step 시작 시 null로 초기화, 충돌 시 obstacleIdx 설정.
export interface CollisionEvent {
  obstacleIdx: number;
}

export interface World {
  tick: number;
  runner: Runner;
  rng: Rng;
  lastCollision: CollisionEvent | null;
  // 봇이 이번 tick에 구멍 낙사했는지 — bench에서 obstacle 충돌사망과 pit 낙사 구분용.
  lastPitFall: boolean;
  loadout: Loadout;
  skills: SkillState[];
  // 트랙 풀과 현재 활성 트랙들
  trackPool: Stage[]; // 추첨용 풀
  currentTrack: Stage;
  currentTrackStart: number; // 절대 거리 기준 현재 트랙의 시작점
  currentItemCollected: boolean[]; // 현재 트랙 아이템 수집 상태
  destroyedObstacles: boolean[]; // 현재 트랙의 파괴된 장애물
  spawnedItems: SpawnedItem[]; // 펫 등으로 동적 생성된 아이템 (현재 트랙용)
  nextTrack: Stage; // 다음에 등장할 트랙 (미리 결정됨, UI에서 미리 그릴 수 있음)
  prevTrack: Stage | null; // 직전 트랙 (시각적 이음새용)
  prevTrackStart: number;
}

export interface Input {
  jump: boolean;
  slide: boolean;
  // 비행 중에 봇이 "다음 trigger 진입 예정" 인지하면 true로 반환.
  // step에서는 봇이 비행 끝(착지)되는 그 tick에 단점프 발동 — 봇이 trigger zone을
  // 1 tick 차이로 지나치는 케이스 (이단점프 후 곧장 high obstacle 만남) 회피용.
  // optional — 기존 input 객체 생성 코드 호환.
  pendingJump?: boolean;
  // 진단용 — decide의 어느 분기가 발동했는지 태깅. 사용 안 하는 코드에 영향 없음.
  debugReason?: string;
}

// 직전 트랙(있다면)을 제외하고 풀에서 무작위 추첨.
// 풀에 1개뿐이면 같은 트랙이 다시 선택됨.
function pickTrack(rng: Rng, pool: Stage[], excludeId: string | null): Stage {
  const candidates =
    excludeId === null ? pool : pool.filter((s) => s.id !== excludeId);
  const source = candidates.length > 0 ? candidates : pool;
  return source[rng.nextInt(0, source.length)]!;
}

// 트랙 수평 좌표(obstacle.x, item.x, length)를 봇 baseRunSpeed에 맞게 환산.
// 환산 후 "obstacle 도달까지 걸리는 시간"이 봇 속도와 무관하게 일정해져
// 봇의 시간 기반 회피 trigger가 자동으로 정확히 정렬됨.
// 수직 좌표(item.y, obstacle.height/yBottom)와 obstacle.width는 환산하지 않음 —
// 점프 정점·박스 충돌은 픽셀 절대값으로 동일하게 유지되어야 회피 동작 일관.
// randomDrops.count는 트랙 픽셀 길이 비례로 늘림 — 픽셀 밀도 일정 유지.
// 결과: 빠른 봇은 같은 시간 안에 더 많은 랜덤 드롭을 만남(속도 부적 보상).
// 고정 obstacle/item은 obstacle과 코인 상대 위치 일관성을 위해 같이 환산.
function scaleTrack(track: Stage, speedRatio: number): Stage {
  // speedRatio=1이라도 원본 mutation을 피하기 위해 clone. coinBoost가 items.value를
  // 수정하는 경우 원본 JSON이 오염되면 결정론 깨짐.
  const scaled: Stage = {
    ...track,
    length: track.length * speedRatio,
    obstacles: track.obstacles.map((o) => ({ ...o, x: o.x * speedRatio })),
    items: track.items.map((i) => ({ ...i, x: i.x * speedRatio })),
  };
  if (track.randomDrops) {
    scaled.randomDrops = {
      ...track.randomDrops,
      count: Math.round(track.randomDrops.count * speedRatio),
    };
  }
  if (track.pits) {
    scaled.pits = track.pits.map((p) => ({
      x: p.x * speedRatio,
      width: p.width * speedRatio,
    }));
  }
  if (track.randomTrack) {
    const baseGap = track.randomTrack.minGap ?? OBSTACLE_MIN_GAP_DEFAULT;
    scaled.randomTrack = {
      ...track.randomTrack,
      // 간격도 봇 속도 비례 환산 — 빠른 봇은 트랙도 늘어났으니 도달 시간 단위로 일정.
      minGap: baseGap * speedRatio,
      pitMinWidth: (track.randomTrack.pitMinWidth ?? 80) * speedRatio,
      pitMaxWidth: (track.randomTrack.pitMaxWidth ?? 130) * speedRatio,
    };
  }
  return scaled;
}

// heal 획득으로 healSpeedBonusMult가 갱신될 때, 봇 실속도 증가에 맞춰 트랙 전체 좌표계와
// 봇 위치·누적 지표를 같은 배율로 곱한다. 봇이 obstacle에 도달하는 "시간"이 일정 유지 →
// 회피 여유 유지. 결정론은 배율 곱만 수행하므로 시드 재현 그대로.
function rescaleWorld(world: World, mult: number): void {
  if (mult === 1) return;
  world.currentTrack = scaleTrack(world.currentTrack, mult);
  world.nextTrack = scaleTrack(world.nextTrack, mult);
  if (world.prevTrack) world.prevTrack = scaleTrack(world.prevTrack, mult);
  world.trackPool = world.trackPool.map((t) => scaleTrack(t, mult));
  for (const sp of world.spawnedItems) sp.x *= mult;
  const r = world.runner;
  r.x *= mult;
  r.totalDistance *= mult;
  r.coinPassiveAnchor *= mult;
  world.currentTrackStart *= mult;
  world.prevTrackStart *= mult;
}

// RandomObstacleKind → 구체 dimension. 트랙 데이터에서 width/height 따로 안 받고
// 종류별 표준 규격 사용 — 무작위 생성을 단순하게.
function obstacleKindToShape(kind: RandomObstacleKind): {
  width: number;
  height: number;
  yBottom: number;
} {
  switch (kind) {
    case "ground":
      return { width: 50, height: 30, yBottom: 0 };
    case "highGround":
      return { width: 50, height: 150, yBottom: 0 };
    case "ceiling":
      return { width: 200, height: 90, yBottom: 30 };
    case "platform":
      // 머리 높이 80 — 봇 단점프 정점 127.8 > 80 + 안전 마진. 봇 단점프로 안전 올라탐.
      // 플랫폼 위에서 점프하면 정점 80 + 127.8 = 207.8 → 높은 장애물(150) 넘김.
      // 폭 250 — 봇이 위에 올라타서 점프할 시간 충분.
      return { width: 250, height: 80, yBottom: 0 };
  }
}

// RandomDropKind → SpawnedItem 형태로 변환.
function dropKindToItem(
  kind: RandomDropKind,
): { value?: number; effect?: import("./stage").ItemEffect } {
  switch (kind) {
    case "coin1":
      return { value: 1 };
    case "coin5":
      return { value: 5 };
    case "coin20":
      return { value: 20 };
    case "heal":
      return { effect: "heal" };
    case "magnet":
      return { effect: "magnet" };
    case "dash":
      return { effect: "dash" };
    case "giant":
      return { effect: "giant" };
    case "coinSpray":
      return { effect: "coinSpray" };
    case "coinBoost":
      return { effect: "coinBoost" };
  }
}

// coinSpray 트리거 시 봇 전방에 코인 3개 소환. y는 [0,60]/[60,120]/[120,180] 3구간에서 각각
// 정수 rng — 서로 다른 y 자동 보장. x는 봇 앞 effSpeed×(0.15~0.3s) 랜덤 → 봇 도달 시간
// 봇 속도와 무관하게 일정. 각 코인 값 확률: 75% v1, 20% v5, 5% v25.
function spawnCoinSprayTriplet(world: World, effSpeed: number): void {
  const r = world.runner;
  const rng = world.rng;
  const leadSec =
    COIN_SPRAY_LEAD_MIN_SEC +
    rng.next() * (COIN_SPRAY_LEAD_MAX_SEC - COIN_SPRAY_LEAD_MIN_SEC);
  const spawnX = r.x + effSpeed * leadSec;
  const segmentSize = (COIN_SPRAY_Y_MAX - COIN_SPRAY_Y_MIN) / COIN_SPRAY_COUNT;
  for (let k = 0; k < COIN_SPRAY_COUNT; k++) {
    const yMin = COIN_SPRAY_Y_MIN + segmentSize * k;
    const yMax = yMin + segmentSize;
    const y = rng.nextInt(Math.round(yMin), Math.round(yMax));
    const roll = rng.next();
    let value: number;
    if (roll < 0.05) value = 25;
    else if (roll < 0.25) value = 5;
    else value = 1;
    world.spawnedItems.push({ x: spawnX, y, value, collected: false });
  }
}

const RANDOM_DROP_MARGIN = 30; // 정적 아이템과 최소 x 간격
const RANDOM_DROP_END_BUFFER = 200; // 트랙 끝 부근 spawn 금지
// 트랙 시작 시점 봇 시야 안 영역에는 spawn 금지 — 봇이 시작부터 보이면 "이미 박혀있던" 느낌으로
// 정적 아이템과 구별 안 됨. 봇 진행하면서 시야에 자연스레 들어오게 시야 끝 너머에만 spawn.
// 값은 UI의 봇 화면 위치(RUNNER_SCREEN_X=100) + 가시 너비(CANVAS_W=800) = 봇.x + 700 기준.
const SPAWN_VIEWPORT_HIDDEN = 700;
const GROUND_Y_LIMIT = 50; // 이 y 이하면 ground 아이템 — 회피점프 비행 영역 회피 필요
const OBSTACLE_LEFT_MARGIN = 80; // 회피점프 trigger 거리 + 여유 (ground 아이템용)
const OBSTACLE_RIGHT_MARGIN = 250; // 단점프 비행 거리(약 210) + 여유 (ground 아이템용)
// 공중 아이템(y>50)이 obstacle 직전에 spawn되면 봇이 점프해도 obstacle 안에서
// ground 도달(ground 장애물) 또는 박스 진입(슬라이드 장애물)이 일어나 미스 →
// 봇 점프 trigger 거리 + 비행 일부 정도 좌측 마진으로 spawn 차단. 슬라이드/ground 공통.
const OBSTACLE_AIR_LEFT_MARGIN = 200;

// 사이클 누적 시간에 따라 코인(coin1/coin5/coin20) 가중치를 늘리는 비율.
// 1초당 +이 비율, heal·magnet·dash·giant는 그대로 → 결과적으로 회복/효과 비율이 점진적으로 ↓.
// 디자인 의도: 무한 런 방지하되 heal 절대량 유지(영영 0이 되지 않게). 사이클 시작 시 리셋.
// 예: 1/60 → 1분에 코인 가중치 ×2 → stage1 heal 비율 10.5% → 5.7%.
const COIN_WEIGHT_GROWTH_PER_SEC = 1 / 60;
const COIN_KINDS = new Set<RandomDropKind>(["coin1", "coin5", "coin20"]);

function coinWeightFactor(elapsedSec: number): number {
  if (elapsedSec <= 0) return 1;
  return 1 + elapsedSec * COIN_WEIGHT_GROWTH_PER_SEC;
}

// 장애물 간 최소 간격 (baseSpeed 환산 픽셀, 기본값).
// 봇 점프 비행거리 ~210px + 단점프 trigger zone 70px → 회피 가능 한도 ~280px 근처.
// 200이면 봇 비행 중 다음 장애물 통과(연속 회피 가능). 더 줄이면 회피 실패 위험 ↑.
// 봇 속도 환산 시 비례 → "도달 시간" 단위로 간격 일관 유지 (트랙 환산 원칙 준수).
const OBSTACLE_MIN_GAP_DEFAULT = 200;
// 높은 장애물(h=150)끼리만 더 큰 간격 보장. 봇 단점프 정점(122.5) < 150이라
// 단점프+정점 이단점프 콤보 비행(~350px)이 필요한데, 그 콤보 비행 후 ground 도달
// 시점에 다음 높은 장애물이 trigger zone(80~105) 안에 들어와야 회피 가능.
// 350(콤보 비행) + 105(trigger 여유) - 50(앞 장애물 폭 보정) ≈ 405.
// 환산: 일반 minGap과 비율 유지 → 봇 baseSpeed 비례 자동 적용.
const HIGH_OBSTACLE_MIN_GAP_DEFAULT = 405;
// 낮은 지상 장애물(h=30)끼리 최소 간격.
// 봇 X(L) 회피점프 발동 zone [20,70]. worst case: gap=20에서 발동 → flightDist 204 → 착지 = X.left+184.
// 착지 후 Y(L) 회피 발동 → Y.left >= 착지 + baseWidth + avoid_low MIN(20) = X.left + 229.
// gap Y-X = 229 - (L width 50) - X.left*0 = 154 필요. 안전 마진 +6 → 160.
const LOW_LOW_MIN_GAP_DEFAULT = 160;
// 낮은 지상 → 높은 지상 (L → H) 조합. Y(H)는 avoid_high MIN 80 확보 필요.
// worst case: X(L) gap=20에서 회피 발동 → 착지 = X.left+184.
// Y.left >= 착지 + baseWidth + avoid_high MIN(80) = X.left + 289.
// gap Y-X = 289 - 50 = 239 필요? 재확인: 착지 위치 = 발동x + flightDist = (X.left-45) + 204 = X.left+159. 봇.right at land = X.left + 184.
// Y.left >= X.left + 184 + 80 = 264. gap = 264 - 50 = 214. 마진 +6 → 220.
const LOW_HIGH_MIN_GAP_DEFAULT = 220;
// 천장 매달림 장애물끼리: 봇 슬라이드 유지 상태면 근접 통과. 130.
const CEILING_CEILING_MIN_GAP_DEFAULT = 130;
// 낮은 지상 ~ 천장 매달림 혼합: 봇이 점프→착지→슬라이드 상태 전환 시간 필요. 160.
const LOW_CEILING_MIN_GAP_DEFAULT = 160;

// 두 인접 원소 종류 조합의 실효 minGap 계산. base minGap 기준으로 비율 곱해 반환.
// platform+platform은 근접 허용(0), high+high는 콤보 비행 후 trigger 확보 위해 크게(405).
// pit이 관련되면 obstacleMargin(base)로 봇 pit 회피 여유 확보.
function comboGap(
  prev: RandomTrackKind,
  curr: RandomTrackKind,
  base: number,
): number {
  // pit ~ 다른 종류 (또는 pit ~ pit): base 값 그대로 (봇 pit 회피 반경 확보).
  if (prev === "pit" || curr === "pit") return base;
  if (prev === "platform" && curr === "platform") return 0;
  if (prev === "platform" || curr === "platform") return base;
  if (prev === "highGround" && curr === "highGround") {
    return base * (HIGH_OBSTACLE_MIN_GAP_DEFAULT / OBSTACLE_MIN_GAP_DEFAULT);
  }
  if (prev === "ground" && curr === "ground") {
    return base * (LOW_LOW_MIN_GAP_DEFAULT / OBSTACLE_MIN_GAP_DEFAULT);
  }
  if (prev === "ceiling" && curr === "ceiling") {
    return base * (CEILING_CEILING_MIN_GAP_DEFAULT / OBSTACLE_MIN_GAP_DEFAULT);
  }
  if (
    (prev === "ground" && curr === "ceiling") ||
    (prev === "ceiling" && curr === "ground")
  ) {
    return base * (LOW_CEILING_MIN_GAP_DEFAULT / OBSTACLE_MIN_GAP_DEFAULT);
  }
  // L → H (또는 H → L). 봇 L 회피 후 착지 위치에서 H avoid_high MIN(80) 확보 필요.
  if (
    (prev === "ground" && curr === "highGround") ||
    (prev === "highGround" && curr === "ground")
  ) {
    return base * (LOW_HIGH_MIN_GAP_DEFAULT / OBSTACLE_MIN_GAP_DEFAULT);
  }
  return base;
}

// 트랙 시작부터 순차적으로 obstacle+pit 통합 배치. 각 위치에서 종류 추첨 후
// 이전 종류와의 combo minGap 만큼 진행 → obstacle/pit 배치.
// xMax 도달할 때까지 반복 → 총 개수는 트랙 길이·minGap·weights로 자연 결정.
// pit도 동일 시퀀스에 포함 → 별도 배치 실패 없음. 밀도 = minGap으로 명확.
// 결정론: rng 시퀀스만으로 결정.
function generateRandomTrack(
  track: Stage,
  rng: Rng,
): { obstacles: Obstacle[]; pits: Pit[] } {
  const cfg = track.randomTrack;
  if (!cfg) return { obstacles: [], pits: [] };

  const kinds: RandomTrackKind[] = [];
  const weights: number[] = [];
  let totalW = 0;
  for (const k of Object.keys(cfg.weights) as RandomTrackKind[]) {
    const w = cfg.weights[k] ?? 0;
    if (w <= 0) continue;
    kinds.push(k);
    weights.push(w);
    totalW += w;
  }
  if (totalW === 0) return { obstacles: [], pits: [] };

  const base = cfg.minGap ?? OBSTACLE_MIN_GAP_DEFAULT;
  // 안전 prefix도 봇 속도(스케일된 minGap)에 비례 확장 —
  // 그러지 않으면 극단 세팅(예: 신발×3 lv30, effSpeed 823px/s)에서 첫 obstacle이
  // 봇의 avoidHighMin(≈220px) 미달 지점에 배치돼 봇이 회피 트리거 zone 진입 못 하고
  // 옆면 충돌 30 데미지(에러리포트 2건). base/OBSTACLE_MIN_GAP_DEFAULT로 speedRatio 유도.
  const safePrefixScale = base / OBSTACLE_MIN_GAP_DEFAULT;
  const xMin = TRACK_SAFE_PREFIX * safePrefixScale;
  const xMax = track.length - RANDOM_DROP_END_BUFFER;
  if (xMax <= xMin) return { obstacles: [], pits: [] };
  const pitMinW = cfg.pitMinWidth ?? 80;
  const pitMaxW = cfg.pitMaxWidth ?? 130;

  const obstacles: Obstacle[] = [];
  const pits: Pit[] = [];

  // 첫 원소는 xMin부터 minGap 이내 랜덤 오프셋 두고 시작 → 트랙마다 시작 위치 다양.
  let prevKind: RandomTrackKind | null = null;
  let prevRight = xMin;
  let cursor = xMin + rng.next() * base;

  while (cursor < xMax) {
    // 종류 추첨
    let pick = rng.next() * totalW;
    let chosen: RandomTrackKind = kinds[0]!;
    for (let i = 0; i < kinds.length; i++) {
      pick -= weights[i]!;
      if (pick <= 0) {
        chosen = kinds[i]!;
        break;
      }
    }

    // 이전 원소와 combo minGap 반영해 실제 배치 x 결정
    if (prevKind !== null) {
      const gap = comboGap(prevKind, chosen, base);
      cursor = Math.max(cursor, prevRight + gap);
    }

    if (chosen === "pit") {
      const width = pitMinW + rng.next() * (pitMaxW - pitMinW);
      if (cursor + width > xMax) break;
      pits.push({ x: cursor, width });
      prevKind = chosen;
      prevRight = cursor + width;
      cursor = prevRight; // 다음 원소는 여기서부터 gap 더해 시작
    } else {
      const shape = obstacleKindToShape(chosen);
      if (cursor + shape.width > xMax) break;
      const obs: Obstacle = {
        x: cursor,
        width: shape.width,
        height: shape.height,
        yBottom: shape.yBottom,
      };
      if (chosen === "platform") obs.kind = "platform";
      obstacles.push(obs);
      prevKind = chosen;
      prevRight = cursor + shape.width;
      cursor = prevRight;
    }

    // 살짝 랜덤 jitter — 매번 최소 gap만 사용하면 배치가 균등해져 자연스럽지 못함.
    // gap 이후 [0, base*0.3] 랜덤 여유 추가 → 균등 분포 완화.
    cursor += rng.next() * base * 0.3;
  }

  return { obstacles, pits };
}

// plate 스폰 시 위쪽에 자동으로 기본 코인 배치 — plate 위 걸어가면 자연 수집.
// y=100: 지면 봇 몸통 [0,80] 밖 (걸어가면 못 먹음) + plate 위 봇 몸통 [80,160] 안 (자동 수집).
// plate 머리(y=80) 바로 위에 살짝 떠있는 자연스러운 위치.
// 봇이 plate 활용할수록 이득이라는 다이나믹스 강화.
const PLATFORM_COIN_Y = 100;
const PLATFORM_COIN_COUNT = 5;
const PLATFORM_COIN_MARGIN = 25; // plate 앞뒤 마진 (봇 진입/이탈 여유)
const PLATFORM_COIN_JITTER = 8;

function generatePlatformCoins(obstacles: Obstacle[], rng: Rng): Item[] {
  const result: Item[] = [];
  const step =
    (250 - 2 * PLATFORM_COIN_MARGIN) / (PLATFORM_COIN_COUNT - 1);
  for (const o of obstacles) {
    if (o.kind !== "platform") continue;
    for (let i = 0; i < PLATFORM_COIN_COUNT; i++) {
      const baseX = o.x + PLATFORM_COIN_MARGIN + i * step;
      const jitter = (rng.next() * 2 - 1) * PLATFORM_COIN_JITTER;
      result.push({ x: baseX + jitter, y: PLATFORM_COIN_Y, value: 1 });
    }
  }
  return result;
}

// 구멍 위쪽에 자동 코인 배치 — 봇이 단점프로 구멍 넘어가면서 자연 수집.
// y=100: plate 위 코인과 동일 y. 봇 단점프 정점(127.8) 부근 궤도가 y=100 지남.
const PIT_COIN_Y = 100;
const PIT_COIN_COUNT = 2;

function generatePitCoins(pits: Pit[]): Item[] {
  const result: Item[] = [];
  for (const p of pits) {
    for (let i = 0; i < PIT_COIN_COUNT; i++) {
      // 균등 분포 — 2개면 0.33, 0.67 위치
      const t = (i + 1) / (PIT_COIN_COUNT + 1);
      result.push({
        x: p.x + p.width * t,
        y: PIT_COIN_Y,
        value: 1,
      });
    }
  }
  return result;
}

// trackPool의 baseline stage(obstacles=[])에 randomObstacles 결과를 박은 사본을 반환.
// 매 호출마다 rng 시퀀스 소비 → 사이클마다·트랙 wrap마다 다른 배치 (결정론은 유지).
// items는 빈 채로 두고 spawnedItems가 randomDrops 결과로 채워짐.
// plate 위 자동 코인은 여기서 items에 부착 (결정론 유지, 정적 아이템 취급).
function realizeTrack(baseTrack: Stage, rng: Rng): Stage {
  if (!baseTrack.randomTrack) return baseTrack;
  const { obstacles, pits } = generateRandomTrack(baseTrack, rng);
  const finalPits = pits.length > 0 ? pits : baseTrack.pits;
  const platformCoins = generatePlatformCoins(obstacles, rng);
  const pitCoins = finalPits ? generatePitCoins(finalPits) : [];
  const extraItems = [...platformCoins, ...pitCoins];
  return {
    ...baseTrack,
    obstacles,
    pits: finalPits,
    items:
      extraItems.length > 0
        ? [...baseTrack.items, ...extraItems]
        : baseTrack.items,
  };
}

// 트랙의 randomDrops 설정대로 SpawnedItem들 생성.
// 결정론 — rng 인자만으로 결과 결정. 같은 시드+같은 트랙+같은 elapsedSec=같은 결과.
// elapsedSec: 사이클 시작부터의 시뮬 누적 시간(초). 코인 가중치 boost 산출용.
function generateRandomDrops(
  track: Stage,
  rng: Rng,
  elapsedSec: number,
): SpawnedItem[] {
  const cfg = track.randomDrops;
  if (!cfg || cfg.count <= 0) return [];

  // 특수(heal/magnet/dash/giant)와 코인(coin1/5/20) 그룹으로 분리해 각각 목표 개수 산출.
  // 특수 목표 개수 = 기존 로직과 동일(count × 특수비율).
  // 코인 목표 개수 = 기존 × 2 — 아이템 밀도만 올리고 특수 개수는 유지.
  const coinFactor = coinWeightFactor(elapsedSec);
  const specialKinds: RandomDropKind[] = [];
  const specialWeights: number[] = [];
  const coinKinds: RandomDropKind[] = [];
  const coinWeights: number[] = [];
  let specialSum = 0;
  let coinSumScaled = 0;
  for (const k of Object.keys(cfg.weights) as RandomDropKind[]) {
    const base = cfg.weights[k] ?? 0;
    if (base <= 0) continue;
    if (COIN_KINDS.has(k)) {
      const w = base * coinFactor;
      coinKinds.push(k);
      coinWeights.push(w);
      coinSumScaled += w;
    } else {
      specialKinds.push(k);
      specialWeights.push(base);
      specialSum += base;
    }
  }
  const totalWeighted = specialSum + coinSumScaled;
  if (totalWeighted === 0) return [];

  const specialCount =
    specialSum > 0
      ? Math.round((cfg.count * specialSum) / totalWeighted)
      : 0;
  const coinCount =
    coinSumScaled > 0
      ? Math.round((cfg.count * coinSumScaled * 2) / totalWeighted)
      : 0;
  const totalCount = specialCount + coinCount;
  if (totalCount === 0) return [];

  const ySlots = cfg.ySlots && cfg.ySlots.length > 0 ? cfg.ySlots : DEFAULT_Y_SLOTS;

  const result: SpawnedItem[] = [];
  const xMin = Math.max(TRACK_SAFE_PREFIX, SPAWN_VIEWPORT_HIDDEN);
  const xMax = track.length - RANDOM_DROP_END_BUFFER;
  if (xMax <= xMin) return [];

  // 충돌 검증: 장애물 박스(x 범위만, 차원 위 spawn은 허용) 또는 정적 아이템과 가까이.
  const obstacleSpansX: { left: number; right: number; yBottom: number; yTop: number }[] =
    track.obstacles.map((o) => ({
      left: o.x,
      right: o.x + o.width,
      yBottom: o.yBottom ?? 0,
      yTop: (o.yBottom ?? 0) + o.height,
    }));

  // 슬롯 카테고리 배열 만들어 셔플 → 특수/코인이 트랙 전역에 고루 섞이게.
  type Category = "special" | "coin";
  const slots: Category[] = [];
  for (let i = 0; i < specialCount; i++) slots.push("special");
  for (let i = 0; i < coinCount; i++) slots.push("coin");
  // Fisher-Yates 셔플 (결정론 rng).
  for (let i = slots.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i + 1);
    const tmp = slots[i]!;
    slots[i] = slots[j]!;
    slots[j] = tmp;
  }

  // 계층 표본 추출 — x 범위를 totalCount 등분해서 각 구간에서 하나씩 뽑는다.
  // 완전 균등 랜덤은 통계적으로 뭉치는 지점이 필연적으로 생겨서, 구간별 표본으로 고르게 분포.
  const bucketW = (xMax - xMin) / totalCount;
  const ATTEMPTS_PER_BUCKET = 6;
  for (let i = 0; i < totalCount; i++) {
    const bucketStart = xMin + i * bucketW;
    const category = slots[i]!;
    const groupKinds = category === "special" ? specialKinds : coinKinds;
    const groupWeights = category === "special" ? specialWeights : coinWeights;
    const groupTotal = category === "special" ? specialSum : coinSumScaled;
    let placed = false;
    for (let a = 0; a < ATTEMPTS_PER_BUCKET && !placed; a++) {
      const x = bucketStart + rng.next() * bucketW;
      const y = ySlots[rng.nextInt(0, ySlots.length)]!;

      // 장애물 박스 안이면 무조건 skip.
      // ground 아이템(y≤50) + ground 장애물(yBottom=0): 회피점프 비행 영역 좌/우 마진 skip
      //   — 봇이 회피 점프 비행 중이라 통과로 못 잡음.
      // 공중 아이템(y>50) + 모든 obstacle: 직전 좌측 마진 skip
      //   — 봇이 점프하면 ground 도달 위치가 obstacle 안(ground 장애물) 또는
      //     비행 중 박스 진입(슬라이드 장애물)이라 봇 점프 차단됨 → 미스.
      let blocked = false;
      const isGround = y <= GROUND_Y_LIMIT;
      for (const o of obstacleSpansX) {
        if (x >= o.left && x <= o.right && y >= o.yBottom && y <= o.yTop) {
          blocked = true;
          break;
        }
        if (isGround && o.yBottom === 0) {
          if (
            x >= o.left - OBSTACLE_LEFT_MARGIN &&
            x <= o.right + OBSTACLE_RIGHT_MARGIN
          ) {
            blocked = true;
            break;
          }
        }
        if (!isGround) {
          if (x >= o.left - OBSTACLE_AIR_LEFT_MARGIN && x <= o.right) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) continue;

      // 정적 아이템과 너무 가까우면 skip
      let tooClose = false;
      for (const item of track.items) {
        if (
          Math.abs(item.x - x) < RANDOM_DROP_MARGIN &&
          Math.abs(item.y - y) < 50
        ) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      // 이미 추가한 spawn 끼리도 겹치지 않게 (구간이 나눠져 있어도 y 슬롯이 같으면 근접 가능)
      let dupClose = false;
      for (const it of result) {
        if (
          Math.abs(it.x - x) < RANDOM_DROP_MARGIN &&
          Math.abs(it.y - y) < 50
        ) {
          dupClose = true;
          break;
        }
      }
      if (dupClose) continue;

      // 그룹 안에서 가중치 추첨
      let pick = rng.next() * groupTotal;
      let chosen: RandomDropKind = groupKinds[0]!;
      for (let j = 0; j < groupKinds.length; j++) {
        pick -= groupWeights[j]!;
        if (pick <= 0) {
          chosen = groupKinds[j]!;
          break;
        }
      }

      result.push({ x, y, ...dropKindToItem(chosen), collected: false });
      placed = true;
    }
  }

  return result;
}

export function createWorld(
  seed: number,
  trackPool: Stage[],
  loadout: Loadout,
): World {
  if (trackPool.length === 0) {
    throw new Error("trackPool은 최소 1개 트랙을 포함해야 함");
  }
  const stats = effectiveStats(loadout);
  const skills: SkillState[] = [];
  if (loadout.character.skill) {
    skills.push(createSkillState(loadout.character.skill, TICK_DURATION));
  }
  if (loadout.pet?.skill) {
    skills.push(createSkillState(loadout.pet.skill, TICK_DURATION));
  }
  // 장비 itemDurationMult가 스킬 지속시간에도 반영되도록 durationTotalTicks 재계산.
  // 스킬 자체 발동(tickSkill에서 cooldown→active 전환) 시 이 값을 사용하므로 반영됨.
  if (stats.itemDurationMult !== 1) {
    for (const s of skills) {
      s.durationTotalTicks = Math.round(
        s.durationTotalTicks * stats.itemDurationMult,
      );
    }
  }
  const rng = new Rng(seed);
  // 봇 baseRunSpeed 기준으로 트랙들 환산 — 같은 트랙도 봇 속도에 따라 obstacle x가
  // 늘어나/줄어 "도달 시간"이 일정해짐. 풀 전체를 미리 환산해 두면 트랙 전환에도 자동 반영.
  const scaledPool = trackPool.map((t) =>
    scaleTrack(t, stats.runSpeed / (t.baseSpeed ?? DEFAULT_TRACK_BASE_SPEED)),
  );
  const baseCurrent = pickTrack(rng, scaledPool, null);
  const currentTrack = realizeTrack(baseCurrent, rng);
  const baseNext = pickTrack(rng, scaledPool, currentTrack.id);
  const nextTrack = realizeTrack(baseNext, rng);
  const slideHeight =
    loadout.character.slideHeight ?? Math.floor(stats.height / 2);
  return {
    tick: 0,
    runner: {
      x: 0,
      y: 0,
      vy: 0,
      baseRunSpeed: stats.runSpeed,
      jumpVelocity: stats.jumpVelocity,
      width: stats.width,
      height: stats.height,
      baseWidth: stats.width,
      baseHeight: stats.height,
      slideHeight,
      sliding: false,
      onGround: true,
      alive: true,
      hp: loadout.character.maxHp,
      maxHp: loadout.character.maxHp,
      invincibleTicks: 0,
      jumpsLeft: loadout.character.maxJumps,
      maxJumps: loadout.character.maxJumps,
      magnetTicks: 0,
      giantTicks: 0,
      itemDashTicks: 0,
      coinSprayTicks: 0,
      coinSpraySpawnAcc: 0,
      coinBoostTicks: 0,
      itemDurationMult: stats.itemDurationMult,
      healAmountMult: stats.healAmountMult,
      healSpeedBoostPct: stats.healSpeedBoostPct,
      healSpeedBonusMult: 1,
      coins: 0,
      totalDistance: 0,
      lap: 0,
      coinPassiveAnchor: 0,
    },
    rng,
    loadout,
    skills,
    trackPool: scaledPool,
    currentTrack,
    currentTrackStart: 0,
    currentItemCollected: new Array(currentTrack.items.length).fill(false),
    destroyedObstacles: new Array(currentTrack.obstacles.length).fill(false),
    // 사이클 시작 — elapsedSec=0 (코인 factor=1, 가중치 그대로)
    spawnedItems: generateRandomDrops(currentTrack, rng, 0),
    nextTrack,
    lastCollision: null,
    lastPitFall: false,
    prevTrack: null,
    prevTrackStart: 0,
  };
}

// 봇이 현재 장애물 데미지에 면역인지 확인 (참고용 헬퍼).
export function isObstacleImmune(world: World): boolean {
  const mods = aggregateSkillModifiers(world.skills);
  return (
    mods.ignoreObstacles ||
    world.runner.invincibleTicks > 0 ||
    world.runner.giantTicks > 0 ||
    world.runner.itemDashTicks > 0
  );
}

// 지속 무적 상태 (dash 스킬 활성 / 거대화 / itemDash / POST_BUFF 잔여 무적 / 충돌 무적) — pit 낙사 무시.
// invincibleTicks는 충돌 무적(60틱=1초) or POST_BUFF 잔여 무적(120틱=2초). 둘 다 pit(폭 80~130,
// 봇 baseSpeed 300 기준 0.27~0.43초 통과)에 충분. 짧다는 이유로 제외했으나 실제로는 pit 통과 여유.
function isLastingImmune(world: World): boolean {
  const mods = aggregateSkillModifiers(world.skills);
  return (
    mods.ignoreObstacles ||
    world.runner.giantTicks > 0 ||
    world.runner.itemDashTicks > 0 ||
    world.runner.invincibleTicks > 0
  );
}

// 펫 destroyer 스킬 발동: 전방 가장 가까운 미파괴 장애물을 파괴하고 회복 아이템 생성.
// 단, 발 아래에 spawn해서 봇이 놓치지 않도록 가까운 거리는 제외한다.
// plate는 발판 역할이라 파괴 대상 제외 (사용자 방침: plate는 활용 대상).
function fireDestroyerSkill(world: World): void {
  const r = world.runner;
  let closestIdx = -1;
  let closestDist = DESTROYER_FORWARD_RANGE;
  for (let i = 0; i < world.currentTrack.obstacles.length; i++) {
    if (world.destroyedObstacles[i]) continue;
    const o = world.currentTrack.obstacles[i]!;
    if (o.kind === "platform") continue;
    const dist = o.x - r.x;
    if (dist < DESTROYER_MIN_DISTANCE) continue;
    if (dist <= closestDist) {
      closestDist = dist;
      closestIdx = i;
    }
  }
  if (closestIdx < 0) return;
  world.destroyedObstacles[closestIdx] = true;
  const o = world.currentTrack.obstacles[closestIdx]!;
  world.spawnedItems.push({
    x: Math.round(o.x + o.width / 2),
    y: 0,
    effect: "heal",
    collected: false,
  });
}

// Box-Muller 변환으로 평균 0·표준편차 1 가우시안 난수 생성 (rng만 사용 — 결정론 유지).
function gaussianRandom(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-10);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const FIREWORK_COIN_COUNT = 10;
const FIREWORK_SCATTER_X = 70; // 수평 가우시안 σ — 대부분 ±200 안, 가끔 더 멀리
const FIREWORK_SCATTER_Y = 60; // 수직 가우시안 σ
const FIREWORK_Y_OFFSET = 50; // 평균 spawn 높이 — ground에 박히지 않게 약간 띄움

// 펫 firework 스킬 발동: destroyer와 동일 패턴으로 가까운 장애물 파괴 후
// 그 위치 주변에 코인을 가우시안 분포로 흩뿌림(중심 밀집 + 가끔 멀리).
// plate는 발판 역할이라 파괴 대상 제외.
function fireFireworkSkill(world: World): void {
  const r = world.runner;
  let closestIdx = -1;
  let closestDist = DESTROYER_FORWARD_RANGE;
  for (let i = 0; i < world.currentTrack.obstacles.length; i++) {
    if (world.destroyedObstacles[i]) continue;
    const o = world.currentTrack.obstacles[i]!;
    if (o.kind === "platform") continue;
    const dist = o.x - r.x;
    if (dist < DESTROYER_MIN_DISTANCE) continue;
    if (dist <= closestDist) {
      closestDist = dist;
      closestIdx = i;
    }
  }
  if (closestIdx < 0) return;
  world.destroyedObstacles[closestIdx] = true;
  const o = world.currentTrack.obstacles[closestIdx]!;
  const cx = o.x + o.width / 2;
  for (let n = 0; n < FIREWORK_COIN_COUNT; n++) {
    const dx = gaussianRandom(world.rng) * FIREWORK_SCATTER_X;
    const dy = gaussianRandom(world.rng) * FIREWORK_SCATTER_Y;
    world.spawnedItems.push({
      x: Math.round(cx + dx),
      y: Math.max(0, Math.round(FIREWORK_Y_OFFSET + dy)),
      value: 1,
      collected: false,
    });
  }
}

// 캐릭터 특성 dashGiant가 있으면 giant를 지정 지속시간만큼 활성.
// 기존 giantTicks가 더 길면 그쪽 유지(아이템 giant 잔여 시간 존중).
function activateDashGiantIfApplicable(world: World, ticks: number): void {
  if (!world.loadout.character.dashGiant) return;
  world.runner.giantTicks = Math.max(world.runner.giantTicks, ticks);
}

// 스킬이 이 틱에 막 활성화됐을 때 발동되는 1회성 효과 (trigger 타입 스킬).
function handleSkillActivation(world: World, skillId: string): void {
  if (skillId === "destroyer") {
    fireDestroyerSkill(world);
  } else if (skillId === "firework") {
    fireFireworkSkill(world);
  } else if (skillId === "dash") {
    // 대시 스킬 활성 순간(자체 발동·아이템 dash로 스킬 켜진 경우 모두)에
    // dashGiant 특성이 있으면 거대화도 동일 지속시간으로 활성.
    // +1: 이 시점 이후 같은 step 안에서 giantTicks--가 실행되므로 이를 흡수해
    // dash activeTicks와 giantTicks가 같은 틱에 0에 도달하도록 정렬한다.
    const dashSkill = world.skills.find((s) => s.spec.id === "dash");
    if (dashSkill) activateDashGiantIfApplicable(world, dashSkill.durationTotalTicks + 1);
  }
}

// 아이템 수집 시 효과 적용. 코인이면 가치 누적, 효과 아이템이면 해당 효과 발동.
function applyItemEffect(world: World, item: Item | SpawnedItem): void {
  const r = world.runner;
  const durMult = r.itemDurationMult;
  if (item.effect === "magnet") {
    r.magnetTicks = Math.max(
      r.magnetTicks,
      Math.round(MAGNET_DURATION_TICKS * durMult),
    );
  } else if (item.effect === "dash") {
    const dashSkill = world.skills.find((s) => s.spec.id === "dash");
    if (dashSkill) {
      // durationTotalTicks는 createWorld에서 이미 itemDurationMult 반영됨.
      dashSkill.activeTicks = dashSkill.durationTotalTicks;
      dashSkill.cooldownTicks = 0;
      // 트랜지션 감지 로직(step 앞부분)은 아이템 수집(step 뒷부분)보다 앞에 실행되므로
      // 여기서 dashGiant를 직접 활성해야 함. handleSkillActivation 경로로는 이 tick에
      // 발동 안 됨.
      activateDashGiantIfApplicable(world, dashSkill.durationTotalTicks + 1);
    } else {
      // dash 스킬 없는 캐릭도 dash 아이템 효과 받게 — itemDashTicks fallback.
      // 이 경로에서는 스킬 활성화 이벤트가 없으니 dashGiant를 직접 트리거.
      const ticks = Math.round(DASH_ITEM_FALLBACK_TICKS * durMult);
      r.itemDashTicks = Math.max(r.itemDashTicks, ticks);
      activateDashGiantIfApplicable(world, ticks);
    }
  } else if (item.effect === "giant") {
    r.giantTicks = Math.max(
      r.giantTicks,
      Math.round(GIANT_DURATION_TICKS * durMult),
    );
  } else if (item.effect === "heal") {
    r.hp = Math.min(r.maxHp, r.hp + HEAL_AMOUNT * r.healAmountMult);
    // 장비 healDash 효과 — 합산해서 itemDashTicks에 max로 적용 (itemDurationMult도 곱).
    let totalSec = 0;
    for (const eq of world.loadout.equipment) {
      totalSec += eq.healDashSeconds ?? 0;
    }
    if (totalSec > 0) {
      const ticks = Math.round((totalSec / TICK_DURATION) * durMult);
      r.itemDashTicks = Math.max(r.itemDashTicks, ticks);
      // healDash로 대시 상태가 되면 dashGiant 특성 발동.
      activateDashGiantIfApplicable(world, ticks);
    }
    // heal 획득 1회당 사이클 동안 이동속도 배율 누적 (여러 장비면 합산 후 1회 누적).
    // 배율 증가 시 트랙 좌표계·봇 위치도 같은 비율로 곱해 obstacle 도달 시간 유지.
    if (r.healSpeedBoostPct > 0) {
      const before = r.healSpeedBonusMult;
      r.healSpeedBonusMult += r.healSpeedBoostPct;
      rescaleWorld(world, r.healSpeedBonusMult / before);
    }
  } else if (item.effect === "coinSpray") {
    r.coinSprayTicks = Math.max(
      r.coinSprayTicks,
      Math.round(COIN_SPRAY_DURATION_TICKS * durMult),
    );
    r.coinSpraySpawnAcc = 0;
  } else if (item.effect === "coinBoost") {
    r.coinBoostTicks = Math.max(
      r.coinBoostTicks,
      Math.round(COIN_BOOST_DURATION_TICKS * durMult),
    );
    // 획득 즉시 currentTrack 정적 items와 spawnedItems 중 v=1 코인을 v=5로 변환.
    // 원본 JSON 오염 방지를 위해 scaleTrack이 currentTrack.items를 이미 clone한 상태여야 함.
    for (const it of world.currentTrack.items) {
      if (it.effect === undefined && (it.value ?? 1) === 1) it.value = 5;
    }
    for (const sp of world.spawnedItems) {
      if (sp.effect === undefined && (sp.value ?? 1) === 1) sp.value = 5;
    }
  } else {
    r.coins += item.value ?? 1;
  }
}

export function step(world: World, input: Input): void {
  if (!world.runner.alive) return;
  world.lastCollision = null;
  world.lastPitFall = false;

  // 트랜지션 감지용 — dash·itemDash·거대화 종료 잔여무적·trigger 타입 스킬 발동에 사용
  const prevActives = world.skills.map((s) => s.activeTicks > 0);
  const dashSkill = world.skills.find((s) => s.spec.id === "dash");
  const dashWasActive = dashSkill ? dashSkill.activeTicks > 0 : false;
  const itemDashWasActive = world.runner.itemDashTicks > 0;
  const giantWasActive = world.runner.giantTicks > 0;

  for (const s of world.skills) tickSkill(s);
  const skillMods = aggregateSkillModifiers(world.skills);

  const r = world.runner;

  // 장비 healDash buff 감소
  if (r.itemDashTicks > 0) r.itemDashTicks--;

  // 스킬 dash·장비 itemDash·거대화가 이 틱에 막 종료 → 잔여 무적 부여
  if (dashWasActive && dashSkill && dashSkill.activeTicks === 0) {
    r.invincibleTicks = Math.max(r.invincibleTicks, POST_BUFF_INVINCIBLE_TICKS);
  }
  if (itemDashWasActive && r.itemDashTicks === 0) {
    r.invincibleTicks = Math.max(r.invincibleTicks, POST_BUFF_INVINCIBLE_TICKS);
  }
  // 거대화는 아래쪽에서 giantTicks-- 후 종료 감지 — 일단 was 플래그만 캡처

  // 최종 모디파이어 — 스킬 dash + 장비 itemDash 동시 켜져도 효과는 같음(속도×2 + 무시)
  const itemDashActive = r.itemDashTicks > 0;
  const mods = {
    speedMultiplier: itemDashActive
      ? Math.max(skillMods.speedMultiplier, 2)
      : skillMods.speedMultiplier,
    ignoreObstacles: skillMods.ignoreObstacles || itemDashActive,
  };

  // 스킬이 이 틱에 막 활성화됐으면 1회성 trigger 효과 발동
  for (let i = 0; i < world.skills.length; i++) {
    const s = world.skills[i]!;
    const nowActive = s.activeTicks > 0;
    if (nowActive && !prevActives[i]) {
      handleSkillActivation(world, s.spec.id);
    }
  }

  if (input.jump && r.jumpsLeft > 0) {
    r.vy = r.jumpVelocity;
    r.jumpsLeft--;
    r.onGround = false;
  }

  r.vy += GRAVITY * TICK_DURATION;
  const dx =
    r.baseRunSpeed * mods.speedMultiplier * r.healSpeedBonusMult * TICK_DURATION;
  const yPrev = r.y;
  r.x += dx;
  r.y += r.vy * TICK_DURATION;
  r.totalDistance += dx;

  // 플랫폼 단방향 착지 — 봇이 위에서 아래로 머리 위 통과 시점에 머리에 착지.
  // 슬라이드 입력 시 떨어지기 의도라 착지 skip.
  let landedOnPlatform = false;
  if (r.vy <= 0 && !input.slide) {
    for (let i = 0; i < world.currentTrack.obstacles.length; i++) {
      if (world.destroyedObstacles[i]) continue;
      const o = world.currentTrack.obstacles[i]!;
      if (o.kind !== "platform") continue;
      const oYTop = (o.yBottom ?? 0) + o.height;
      if (r.x + r.baseWidth > o.x && r.x < o.x + o.width) {
        if (yPrev >= oYTop && r.y <= oYTop) {
          r.y = oYTop;
          r.vy = 0;
          r.onGround = true;
          r.jumpsLeft = r.maxJumps;
          landedOnPlatform = true;
          break;
        }
      }
    }
  }

  // 구멍 — 봇이 ground(y<=0)에 닿는데 그 x가 구멍 안이면 ground 처리 안 함 → 봇 떨어짐 → 사망.
  // 봇.y가 트랙 바닥 한도(-100) 아래로 떨어지면 즉시 사망 처리.
  // 단, 지속 무적(dash·거대화·itemDash) 상태면 pit 위에서도 지면처럼 통과 — 사용자 설계 결정.
  const pits = world.currentTrack.pits ?? [];
  let inPit = false;
  if (r.y <= 0) {
    for (const pit of pits) {
      if (r.x + r.baseWidth > pit.x && r.x < pit.x + pit.width) {
        inPit = true;
        break;
      }
    }
  }
  // 무적 상태면 pit 위여도 지면 처리 → 봇 그대로 걸어감.
  if (inPit && isLastingImmune(world)) {
    inPit = false;
  }
  if (!landedOnPlatform) {
    if (r.y <= 0 && !inPit) {
      r.y = 0;
      r.vy = 0;
      r.onGround = true;
      r.jumpsLeft = r.maxJumps;
    } else if (r.y < -100) {
      // 봇이 구멍 너머 트랙 바닥 한도 아래로 떨어짐 → 사망
      r.alive = false;
      r.hp = 0;
      world.lastPitFall = true;
    }
  }

  // 봇이 플랫폼 위(onGround + y>0) 상태에서 플랫폼 우측 끝났거나 슬라이드 입력 시 떨어지기
  if (r.onGround && r.y > 0) {
    let stillOnPlatform = false;
    for (let i = 0; i < world.currentTrack.obstacles.length; i++) {
      if (world.destroyedObstacles[i]) continue;
      const o = world.currentTrack.obstacles[i]!;
      if (o.kind !== "platform") continue;
      const oYTop = (o.yBottom ?? 0) + o.height;
      if (
        Math.abs(r.y - oYTop) < 0.5 &&
        r.x + r.baseWidth > o.x &&
        r.x < o.x + o.width
      ) {
        stillOnPlatform = true;
        break;
      }
    }
    if (!stillOnPlatform || input.slide) {
      r.onGround = false;
    }
  }

  // 비행 중 봇이 예약한 점프 — 착지된 이 tick에 즉시 단점프 발동.
  // 봇이 비행 중에 다음 obstacle trigger 진입 예측해서 pendingJump=true 반환했고
  // 이번 tick에 착지했다면, 한 tick 늦지 않고 즉시 회피 단점프 발동.
  if (input.pendingJump && r.onGround && r.jumpsLeft > 0) {
    r.vy = r.jumpVelocity;
    r.jumpsLeft--;
    r.onGround = false;
  }

  // 효과 타이머 감소
  if (r.magnetTicks > 0) r.magnetTicks--;
  if (r.giantTicks > 0) r.giantTicks--;
  if (r.coinSprayTicks > 0) r.coinSprayTicks--;
  if (r.coinBoostTicks > 0) r.coinBoostTicks--;
  // 거대화가 이 틱에 막 종료 → 잔여 무적 부여
  if (giantWasActive && r.giantTicks === 0) {
    r.invincibleTicks = Math.max(r.invincibleTicks, POST_BUFF_INVINCIBLE_TICKS);
  }

  // coinSpray 활성 중: 봇 x 누적 이동 dx를 acc에 쌓아 COIN_SPRAY_TRIGGER_DIST마다 소환.
  if (r.coinSprayTicks > 0) {
    r.coinSpraySpawnAcc += dx;
    const effSpeed =
      r.baseRunSpeed * mods.speedMultiplier * r.healSpeedBonusMult;
    while (r.coinSpraySpawnAcc >= COIN_SPRAY_TRIGGER_DIST) {
      r.coinSpraySpawnAcc -= COIN_SPRAY_TRIGGER_DIST;
      spawnCoinSprayTriplet(world, effSpeed);
    }
  }
  // coinBoost 활성 중: 매 tick 새로 spawn된 v=1도 5로 변환 (자석 무관 스캔).
  // O(items+spawnedItems) — 벤치 오버헤드 작음. 활성 지속 3초.
  if (r.coinBoostTicks > 0) {
    for (const it of world.currentTrack.items) {
      if (it.effect === undefined && (it.value ?? 1) === 1) it.value = 5;
    }
    for (const sp of world.spawnedItems) {
      if (sp.effect === undefined && (sp.value ?? 1) === 1) sp.value = 5;
    }
  }

  // 슬라이드 / 거대화에 따라 effective 크기 결정 (거대화 우선)
  const giantActive = r.giantTicks > 0;
  r.sliding = input.slide && r.onGround && !giantActive;
  if (giantActive) {
    r.width = r.baseWidth * GIANT_SCALE;
    r.height = r.baseHeight * GIANT_SCALE;
  } else if (r.sliding) {
    r.width = r.baseWidth;
    r.height = r.slideHeight;
  } else {
    r.width = r.baseWidth;
    r.height = r.baseHeight;
  }

  r.hp -= TIME_DAMAGE_PER_SEC * TICK_DURATION;

  if (r.invincibleTicks > 0) r.invincibleTicks--;

  // 장애물 충돌 — 거대화 시 무시. 파괴된 장애물도 무시. 플랫폼은 단방향이라 제외.
  if (!mods.ignoreObstacles && r.invincibleTicks === 0 && !giantActive) {
    for (let i = 0; i < world.currentTrack.obstacles.length; i++) {
      if (world.destroyedObstacles[i]) continue;
      const o = world.currentTrack.obstacles[i]!;
      if (o.kind === "platform") continue;
      const oYBottom = o.yBottom ?? 0;
      const oYTop = oYBottom + o.height;
      if (
        r.x + r.width > o.x &&
        r.x < o.x + o.width &&
        r.y < oYTop &&
        r.y + r.height > oYBottom
      ) {
        r.hp -= OBSTACLE_DAMAGE;
        r.invincibleTicks = INVINCIBLE_TICKS;
        world.lastCollision = { obstacleIdx: i };
        break;
      }
    }
  }

  // 자석 활성 시 범위 안 미수집 아이템 모두 흡수 (정적 + 동적 spawned)
  if (r.magnetTicks > 0) {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const r2 = MAGNET_RANGE * MAGNET_RANGE;
    for (let i = 0; i < world.currentTrack.items.length; i++) {
      if (world.currentItemCollected[i]) continue;
      const item = world.currentTrack.items[i]!;
      const ddx = item.x - cx;
      const ddy = item.y - cy;
      if (ddx * ddx + ddy * ddy <= r2) {
        world.currentItemCollected[i] = true;
        applyItemEffect(world, item);
      }
    }
    for (const sp of world.spawnedItems) {
      if (sp.collected) continue;
      const ddx = sp.x - cx;
      const ddy = sp.y - cy;
      if (ddx * ddx + ddy * ddy <= r2) {
        sp.collected = true;
        applyItemEffect(world, sp);
      }
    }
  }

  // 일반 박스 수집 — 정적 아이템
  for (let i = 0; i < world.currentTrack.items.length; i++) {
    if (world.currentItemCollected[i]) continue;
    const item = world.currentTrack.items[i]!;
    if (
      item.x >= r.x &&
      item.x <= r.x + r.width &&
      item.y >= r.y &&
      item.y <= r.y + r.height
    ) {
      world.currentItemCollected[i] = true;
      applyItemEffect(world, item);
    }
  }

  // 일반 박스 수집 — spawned 아이템
  for (const sp of world.spawnedItems) {
    if (sp.collected) continue;
    if (
      sp.x >= r.x &&
      sp.x <= r.x + r.width &&
      sp.y >= r.y &&
      sp.y <= r.y + r.height
    ) {
      sp.collected = true;
      applyItemEffect(world, sp);
    }
  }

  // 캐릭터 패시브 — coinPerDistance 단위로 코인 자동 적립.
  const coinPerDist = world.loadout.character.coinPerDistance;
  if (coinPerDist && coinPerDist > 0) {
    const passed = r.totalDistance - r.coinPassiveAnchor;
    if (passed >= coinPerDist) {
      const earned = Math.floor(passed / coinPerDist);
      r.coins += earned;
      r.coinPassiveAnchor += earned * coinPerDist;
    }
  }

  if (r.hp <= 0) {
    r.hp = 0;
    r.alive = false;
    world.tick++;
    return;
  }

  // 트랙 끝 도달 → 다음 트랙으로 이동
  if (r.x >= world.currentTrack.length) {
    const oldLength = world.currentTrack.length;
    world.prevTrack = world.currentTrack;
    world.prevTrackStart = world.currentTrackStart;
    world.currentTrack = world.nextTrack;
    world.currentTrackStart += oldLength;
    // 새 nextTrack을 baseline에서 추첨 후 realize (랜덤 장애물 새로 생성).
    const baseNext = pickTrack(world.rng, world.trackPool, world.currentTrack.id);
    world.nextTrack = realizeTrack(baseNext, world.rng);
    world.currentItemCollected = new Array(
      world.currentTrack.items.length,
    ).fill(false);
    world.destroyedObstacles = new Array(
      world.currentTrack.obstacles.length,
    ).fill(false);
    // 트랙 wrap 시점 누적 시뮬 시간으로 코인 가중치 boost
    world.spawnedItems = generateRandomDrops(
      world.currentTrack,
      world.rng,
      world.tick * TICK_DURATION,
    );
    r.x -= oldLength;
    r.lap++;
  }

  world.tick++;
}
