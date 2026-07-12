// 스테이지 정의 — 결정론 보장을 위해 모두 정적 데이터.

export interface Obstacle {
  x: number; // 장애물 왼쪽 끝의 수평 위치
  width: number; // 가로 크기
  height: number; // 세로 크기
  yBottom?: number; // 충돌 박스 아래쪽 y (생략 시 0=지면 장애물). >0이면 천장 매달림
  // "block" (생략 시 기본): 모든 방향 박스 충돌. 기존 지상/천장 장애물.
  // "platform": 단방향. 봇이 위에서 떨어져 머리에 닿을 때만 착지 처리. 옆/아래 진입은 통과.
  //   머리 위에서 슬라이드 입력 시 봇 발이 머리에서 떨어짐 (내려오기). yBottom 0 가정.
  kind?: "block" | "platform";
}

// 구멍 — 봇이 그 x 범위 안에서 발이 ground(y=0)에 닿지 못함. 봇 발이 그 위에서
// 떠받쳐지지 않아 떨어짐. 봇.y가 트랙 바닥 아래로 떨어지면 즉시 사망.
export interface Pit {
  x: number; // 구멍 왼쪽 끝
  width: number; // 구멍 가로 크기
}

export type ItemEffect =
  | "magnet"
  | "dash"
  | "giant"
  | "heal"
  | "coinSpray" // 3초 동안 봇 50px 이동마다 전방에 코인 3개 소환
  | "coinBoost"; // 3초 동안 맵의 모든 v=1 코인을 v=5로 변환 (원복 없음)

export interface Item {
  x: number; // 아이템 수평 위치 (점 좌표)
  y: number; // 아이템 수직 위치
  value?: number; // 코인 가치 (생략 시 1, 효과 아이템에는 보통 없음)
  effect?: ItemEffect; // 효과 아이템 종류 (있으면 코인이 아님)
}

// 트랙 진입 시 추가로 흩뿌릴 랜덤 spawn 정의 — 결정론 시드 기반.
// 트랙별로 가중치를 다르게 둬서 "코인 많은 트랙", "회복 많은 트랙" 같은 차별화에 사용.
export type RandomDropKind =
  | "coin1"
  | "coin5"
  | "coin20"
  | "heal"
  | "magnet"
  | "dash"
  | "giant"
  | "coinSpray"
  | "coinBoost";

export interface RandomDrops {
  count: number; // 트랙당 spawn 개수
  weights: Partial<Record<RandomDropKind, number>>; // 정수 가중치
  ySlots?: number[]; // y 추첨 풀 (생략 시 디폴트 — ground+공중 혼합)
}

// 트랙 진입 시 무작위 배치할 장애물 종류.
// "ground" = 낮은 지상 (단점프로 회피)
// "highGround" = 높은 지상 (단점프+이단점프 콤보 필요)
// "ceiling" = 천장 매달림 (슬라이드로 회피)
// "platform" = 공중 발판 (단점프로 올라타기, 슬라이드로 내려오기)
export type RandomObstacleKind = "ground" | "highGround" | "ceiling" | "platform";

// 순차 배치 방식 종류 — 장애물 4종 + pit.
// 하나씩 트랙 시작부터 순차 배치하며 종류별 minGap을 지킴 → 밀도가 minGap으로 자연 결정.
// 총 개수는 트랙 길이에 따라 유동적. pit도 동일 시퀀스에서 배치 → 밀도 경쟁 없이 자연 스폰.
export type RandomTrackKind = RandomObstacleKind | "pit";

export interface RandomTrack {
  weights: Partial<Record<RandomTrackKind, number>>; // 종류별 가중치 (pit 포함)
  minGap?: number; // 기본 minGap — 조합별 실효 gap은 이 값에 조합 계수 곱해 결정. baseSpeed 기준.
  pitMinWidth?: number; // pit 최소 폭 (기본 80). baseSpeed 기준.
  pitMaxWidth?: number; // pit 최대 폭 (기본 130). baseSpeed 기준.
}

export interface Stage {
  id: string; // 트랙 식별자 (중복 방지·디버그용)
  length: number; // 트랙 전체 수평 길이 (baseSpeed 기준 픽셀)
  obstacles: Obstacle[];
  items: Item[];
  pits?: Pit[]; // 정적 구멍 (생략 가능)
  randomDrops?: RandomDrops;
  randomTrack?: RandomTrack; // 순차 배치 (장애물 + pit 통합) — 신규 방식
  // 트랙 데이터(obstacle.x, item.x, length 등)가 기준한 캐릭터 속도(px/s).
  // 봇 시뮬 시점에 봇의 baseRunSpeed/baseSpeed 비율로 모든 위치를 환산해
  // "도달 시간"이 봇 속도와 무관하게 일정하도록 함 → 속도 부적·새 캐릭터 등에서도
  // 봇 회피 동작 자동 정렬, 트랙 디자인 수정 불필요.
  baseSpeed?: number;
}

// 트랙 데이터에 baseSpeed가 명시되지 않을 때 사용할 기본값(디폴트 캐릭터 속도와 동일).
export const DEFAULT_TRACK_BASE_SPEED = 300;

// randomDrops에 ySlots가 없을 때 사용할 디폴트 추첨 풀.
// ground·단점프 영역·이단점프 영역 골고루.
export const DEFAULT_Y_SLOTS = [0, 0, 0, 0, 80, 80, 120, 150, 180, 210];

// 장애물/아이템이 전혀 없는 빈 트랙 (물리 검증용)
export const EMPTY_STAGE: Stage = {
  id: "empty",
  length: 100000,
  obstacles: [],
  items: [],
};

// 트랙 시작 부분의 안전 구간 (장애물 금지) — 봇이 트랙 경계를 신경 쓸 필요 없게 함
export const TRACK_SAFE_PREFIX = 200;
