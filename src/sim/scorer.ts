// 적응형 이단점프 타이밍용 점수 함수.
//
// 봇의 현재 상태에 대해 "다음 N tick 동안 이 행동 계획을 따르면 결과가 어떻게 되나"를
// 시뮬레이션하고 점수를 낸다. 봇 decide()가 여러 행동 계획을 스코어링 → 최고점 선택.
//
// 시뮬 범위(N tick, 호라이즌)는 봇 단점프 flight cycle(≈40 tick) 정도.
// 이 안에서 발생하는 아이템 수집·pit 낙사·obstacle 옆면 충돌을 점수화.
// 스킬 발동(destroyer/firework), 트랙 wrap 은 이 시간 안 흔치 않아 무시(근사).

import { World, TICK_DURATION, Input } from "./world";
import { Item, Obstacle, Pit } from "./stage";

const GRAVITY_ABS = 2200; // world.ts GRAVITY의 절댓값
const OBSTACLE_DAMAGE = 30;
const INVINCIBLE_TICKS = 60;
const MAGNET_RANGE = 250;
const GIANT_SCALE = 2;

// 점수 가중치 — 사고 심각도 차등.
// pit 낙사: 즉사 확정 (hp 100 → 0 순간).
// 옆면 충돌: 30 hp 데미지, 무적 60틱, 살아남음 (hp 30 이상이면).
// 통일 -10000이면 "pit 낙사(즉사) vs 옆면 충돌(감수)" 상황에서 봇 판단 못 함 → 잘못하면 pit 선택.
// pit -50000으로 5배 무겁게 → 옆면 충돌 감수해서라도 pit 회피 우선.
// heal(+1000)로 -1000 회복 안 되므로 이득 목적 부딪히기도 방지.
const PIT_PENALTY = -50000;
const COLLISION_PENALTY = -1000;

// 아이템 우선순위 — bot.ts의 itemPriority와 일치.
function itemScore(item: { value?: number; effect?: string }): number {
  if (item.effect === "magnet") return 1500;
  if (item.effect === "heal") return 1000;
  if (item.effect) return 100;
  return item.value ?? 1;
}

interface SimState {
  x: number;
  y: number;
  vy: number;
  jumpsLeft: number;
  onGround: boolean;
  height: number;
  width: number;
  baseHeight: number;
  baseWidth: number;
  slideHeight: number;
  jumpVelocity: number;
  maxJumps: number;
  giantTicks: number;
  itemDashTicks: number;
  invincibleTicks: number;
  magnetTicks: number;
  alive: boolean;
}

export interface ScoreDetails {
  itemsCaughtScore: number;
  collisionCount: number;
  pitFell: boolean;
  finalX: number;
  finalY: number;
  ticksSimulated: number;
}

export interface ScoreResult {
  score: number;
  details: ScoreDetails;
}

// 봇 몸통 사각형이 immune 상태(장애물 무시)인지.
function isSimImmune(state: SimState): boolean {
  return (
    state.giantTicks > 0 ||
    state.itemDashTicks > 0 ||
    state.invincibleTicks > 0
  );
}

// pit 낙사 판정용 지속 무적(giant/itemDash) 여부. invincibleTicks(충돌 잔여)는 pit엔 무관.
function isLastingImmuneForPit(state: SimState): boolean {
  return state.giantTicks > 0 || state.itemDashTicks > 0;
}

// obstacles·pits·items를 currentTrack + nextTrack 이음새 반영해 절대 x로 나열.
// 시뮬 tick 안에서 트랙 wrap 감지되면 nextTrack 원소도 참조 대상.
// 봇 x는 실제 x (트랙 오프셋 반영). 여기선 사이드로 nextTrack 데이터도 offset 적용해 반환.
function collectVisibleTrackData(world: World) {
  const cur = world.currentTrack;
  const nxt = world.nextTrack;
  const offset = cur.length;
  const obstacles: (Obstacle & { index: number; fromNext: boolean })[] = [];
  const pits: (Pit & { fromNext: boolean })[] = [];
  const items: (Item & { index: number; fromNext: boolean })[] = [];
  for (let i = 0; i < cur.obstacles.length; i++) {
    if (world.destroyedObstacles[i]) continue;
    obstacles.push({ ...cur.obstacles[i]!, index: i, fromNext: false });
  }
  for (const p of cur.pits ?? []) pits.push({ ...p, fromNext: false });
  for (let i = 0; i < cur.items.length; i++) {
    if (world.currentItemCollected[i]) continue;
    items.push({ ...cur.items[i]!, index: i, fromNext: false });
  }
  for (let i = 0; i < nxt.obstacles.length; i++) {
    const o = nxt.obstacles[i]!;
    obstacles.push({ ...o, x: o.x + offset, index: i, fromNext: true });
  }
  for (const p of nxt.pits ?? []) {
    pits.push({ ...p, x: p.x + offset, fromNext: true });
  }
  for (let i = 0; i < nxt.items.length; i++) {
    const it = nxt.items[i]!;
    items.push({ ...it, x: it.x + offset, index: i, fromNext: true });
  }
  return { obstacles, pits, items };
}

// 스폰 아이템(펫 스킬 등으로 동적 배치)도 참조 대상 — 현재 x 그대로.
function collectSpawned(world: World) {
  const spawned: {
    idx: number;
    x: number;
    y: number;
    value?: number;
    effect?: string;
  }[] = [];
  for (let i = 0; i < world.spawnedItems.length; i++) {
    const sp = world.spawnedItems[i]!;
    if (sp.collected) continue;
    spawned.push({
      idx: i,
      x: sp.x,
      y: sp.y,
      value: sp.value,
      effect: sp.effect,
    });
  }
  return spawned;
}

// 봇 현재 상태에 맞는 유의미한 행동 계획 후보 나열.
// - 지상 & jumpsLeft=maxJumps: nop / 슬라이드 / 지금 단점프 (± 이단점프 timing) / 지연 단점프
// - 공중 & jumpsLeft>=1: nop / 지금 이단점프 / 지연 이단점프
// - 공중 & jumpsLeft=0: nop 만
export function generateCandidatePlans(
  world: World,
  horizon: number = 40,
): { label: string; plan: Input[] }[] {
  const r = world.runner;
  const plans: { label: string; plan: Input[] }[] = [];
  const nop: Input[] = Array.from({ length: horizon }, () => ({
    jump: false,
    slide: false,
  }));

  // nop 항상 포함 — baseline
  plans.push({ label: "nop", plan: nop });

  // 지상에서 슬라이드 — 봇 decide는 매 tick 재판정이라 슬라이드 필요 기간만 지속.
  // 스코어러는 40 tick 전체 시나리오 시뮬이므로, 슬라이드 후보도 여러 지속 길이 검토.
  // slide@k = tick 0~k-1까지 슬라이드, 그 뒤 nop. 천장이 언제 지나가느냐에 따라 최적 k 다름.
  if (r.onGround) {
    for (const dur of [1, 5, 10, 20, 40]) {
      const slidePlan = nop.map((x) => ({ ...x }));
      for (let i = 0; i < Math.min(dur, horizon); i++) {
        slidePlan[i] = { jump: false, slide: true };
      }
      plans.push({ label: `slide×${dur}`, plan: slidePlan });
    }
  }

  // 첫 점프 발동 시점 후보 (0=지금, 1,2,3=지연). 지상이거나 공중에서 jumpsLeft>=1이면 유효.
  // 지상: single jump. 공중: double jump. jumpsLeft 소모.
  if (r.jumpsLeft > 0) {
    const firstJumpTicks = r.onGround ? [0, 1, 2, 3, 4, 5] : [];
    for (const t1 of firstJumpTicks) {
      const singleP = nop.map((x) => ({ ...x }));
      singleP[t1] = { jump: true, slide: false };
      plans.push({ label: `single@${t1}`, plan: singleP });

      if (r.jumpsLeft >= 2) {
        // 지상에서 첫 점프 후 이단점프 timing 여러 후보
        const doubleTicks = [t1 + 1, t1 + 5, t1 + 10, t1 + 15, t1 + 20, t1 + 25, t1 + 30];
        for (const t2 of doubleTicks) {
          if (t2 >= horizon) continue;
          const comboP = nop.map((x) => ({ ...x }));
          comboP[t1] = { jump: true, slide: false };
          comboP[t2] = { jump: true, slide: false };
          plans.push({ label: `combo@${t1}+${t2}`, plan: comboP });
        }
      }
    }

    // 공중 상태 후보 — jumpsLeft에 따라 다름.
    if (!r.onGround) {
      // j>=1: 단일 jump timing 후보 (마지막 남은 jump 언제 쓸지)
      const singleTicks = [0, 1, 2, 3, 5, 7, 10, 13, 16, 20, 24, 28, 32, 36];
      for (const t of singleTicks) {
        if (t >= horizon) continue;
        const p = nop.map((x) => ({ ...x }));
        p[t] = { jump: true, slide: false };
        plans.push({ label: `airjump@${t}`, plan: p });
      }
      // j>=2: 공중 콤보 후보 — 플랫폼에서 낙하 등으로 j=2 상태로 공중 있는 경우.
      // 두 jump를 언제·언제 쓸지 조합 후보. 낭비 방지 (매 tick 근시안 결정으로 두 jump 다 소모하는 버그 대응).
      if (r.jumpsLeft >= 2) {
        const firstTicks = [0, 2, 5, 10, 15];
        for (const t1 of firstTicks) {
          if (t1 >= horizon) continue;
          const gaps = [5, 10, 15, 20, 25, 30, 40];
          for (const gap of gaps) {
            const t2 = t1 + gap;
            if (t2 >= horizon) continue;
            const p = nop.map((x) => ({ ...x }));
            p[t1] = { jump: true, slide: false };
            p[t2] = { jump: true, slide: false };
            plans.push({ label: `aircombo@${t1}+${t2}`, plan: p });
          }
        }
      }
    }
  }

  return plans;
}

// 공중 상태 봇의 이단점프 최적 타이밍 찾기.
// 결과:
//   { fire: true, tick: 0 } — 지금 발동이 최선
//   { fire: false, waitTick: k>0 } — k tick 후 발동이 최선 (지금은 대기)
//   { fire: false, noJump: true } — 이단점프 안 하는 게 최선
// 스코어러가 nop/double@k 후보들 비교해 최고점 선택.
// 호라이즌 100 tick — 최악 조합 (플랫폼 y=80 시작 + 15 tick 지연 콤보) 89 tick + 여유 11.
// 콤보 정점 이단점프의 물리적 최대 비행: 정점까지 20.45 + 콤보 정점까지 20.45 + 낙하 33.16 = 74 tick.
// 지연 발동 후보 최대 15 tick + 74 tick = 89 tick 필요.
export function bestDoubleJumpTiming(
  world: World,
  effSpeed: number,
  horizon: number = 100,
): { fire: boolean; tick: number; noJump: boolean; score: number; label: string } {
  const r = world.runner;
  if (r.onGround || r.jumpsLeft === 0) {
    return { fire: false, tick: -1, noJump: true, score: 0, label: "n/a" };
  }
  // 공중 관련 후보만 필터 — nop, airjump@*, aircombo@*.
  // 지상 관련(single@k, combo@) 은 봇이 이 함수를 지상에서 호출 안 하므로 무관하지만 필터로 배제.
  const candidates = generateCandidatePlans(world, horizon).filter(
    (c) =>
      c.label === "nop" ||
      c.label.startsWith("airjump@") ||
      c.label.startsWith("aircombo@"),
  );
  // tie-break — 점수 동점 시 첫 tick에 nop인 계획 우선.
  // 이유: 무의미한 점프 남발 방지. sim에서 여러 fire timing 결과 동일이면 대기 후
  //   자연스레 fire 될 tick까지 유예 (봇 다음 tick 재판정으로 최적 타이밍 자동 도달).
  let best = candidates[0]!;
  let bestScore = -Infinity;
  let bestPriority = -1;
  const firstActionPriority = (plan: Input[]): number => {
    const first = plan[0]!;
    if (!first.jump && !first.slide) return 3;
    if (first.slide) return 2;
    return 1;
  };
  for (const c of candidates) {
    const res = scoreActionPlan(world, c.plan, effSpeed);
    const pri = firstActionPriority(c.plan);
    const replace =
      res.score > bestScore ||
      (res.score === bestScore && pri > bestPriority);
    if (replace) {
      bestScore = res.score;
      bestPriority = pri;
      best = c;
    }
  }
  if (best.label === "nop") {
    return { fire: false, tick: -1, noJump: true, score: bestScore, label: "nop" };
  }
  // 첫 jump tick 추출 — airjump@k 또는 aircombo@t1+t2 (t1 사용).
  let firstTick = 0;
  if (best.label.startsWith("airjump@")) {
    firstTick = parseInt(best.label.replace("airjump@", ""), 10);
  } else if (best.label.startsWith("aircombo@")) {
    const m = best.label.match(/aircombo@(\d+)\+(\d+)/);
    if (m) firstTick = parseInt(m[1]!, 10);
  }
  return {
    fire: firstTick === 0,
    tick: firstTick,
    noJump: false,
    score: bestScore,
    label: best.label,
  };
}

// 후보들 중 최고점 계획 선택.
// tie-break — 점수 동점 시 nop → slide → jump 우선 (무의미한 행동 방지).
export function bestActionPlan(
  world: World,
  effSpeed: number,
  horizon: number = 40,
): { label: string; plan: Input[]; score: number; details: ScoreDetails } {
  const candidates = generateCandidatePlans(world, horizon);
  let best = candidates[0]!;
  let bestScore = -Infinity;
  let bestPriority = -1;
  let bestDetails: ScoreDetails = {
    itemsCaughtScore: 0,
    collisionCount: 0,
    pitFell: false,
    finalX: 0,
    finalY: 0,
    ticksSimulated: 0,
  };
  const firstActionPriority = (plan: Input[]): number => {
    const first = plan[0]!;
    if (!first.jump && !first.slide) return 3;
    if (first.slide) return 2;
    return 1;
  };
  for (const c of candidates) {
    const res = scoreActionPlan(world, c.plan, effSpeed);
    const pri = firstActionPriority(c.plan);
    const replace =
      res.score > bestScore ||
      (res.score === bestScore && pri > bestPriority);
    if (replace) {
      bestScore = res.score;
      bestPriority = pri;
      best = c;
      bestDetails = res.details;
    }
  }
  return {
    label: best.label,
    plan: best.plan,
    score: bestScore,
    details: bestDetails,
  };
}

export function scoreActionPlan(
  world: World,
  plan: Input[],
  effSpeed: number,
): ScoreResult {
  const r = world.runner;
  const state: SimState = {
    x: r.x,
    y: r.y,
    vy: r.vy,
    jumpsLeft: r.jumpsLeft,
    onGround: r.onGround,
    height: r.height,
    width: r.width,
    baseHeight: r.baseHeight,
    baseWidth: r.baseWidth,
    slideHeight: r.slideHeight,
    jumpVelocity: r.jumpVelocity,
    maxJumps: r.maxJumps,
    giantTicks: r.giantTicks,
    itemDashTicks: r.itemDashTicks,
    invincibleTicks: r.invincibleTicks,
    magnetTicks: r.magnetTicks,
    alive: true,
  };

  const track = collectVisibleTrackData(world);
  const spawned = collectSpawned(world);
  const collectedStaticThisSim = new Set<number>(); // key: index (currentTrack) + offset
  const collectedSpawnThisSim = new Set<number>();

  let itemsScore = 0;
  let collisionCount = 0;
  let pitFell = false;
  // 착지 후 walking 충돌 검사 지속 여부 — 착지 시 obstacle 여유 부족(회피 불가)이면 true.
  // 이후 tick들의 walking 충돌도 count함 (봇 실제로 회피 불가한 상황).
  let unsafeAfterLanding = false;
  let landingChecked = false;

  const N = plan.length;
  let simulated = 0;

  for (let tick = 0; tick < N; tick++) {
    if (!state.alive) break;
    const input = plan[tick]!;
    simulated++;

    // (0) 이번 tick 시작 시 immunity 감소는 나중에 (world.ts와 순서 맞춤)

    // (1) jump 입력 처리 — 지상/공중 관계없이 jumpsLeft 있으면 vy 재설정
    if (input.jump && state.jumpsLeft > 0) {
      state.vy = state.jumpVelocity;
      state.jumpsLeft -= 1;
      state.onGround = false;
    }

    // (2) 물리
    state.vy -= GRAVITY_ABS * TICK_DURATION;
    const yPrev = state.y;
    state.x += effSpeed * TICK_DURATION;
    state.y += state.vy * TICK_DURATION;

    // (3) 플랫폼 착지 — 봇이 위에서 아래로 platform 머리 통과 시점
    let landedOnPlatform = false;
    if (state.vy <= 0 && !input.slide) {
      for (const o of track.obstacles) {
        if (o.kind !== "platform") continue;
        const oYTop = (o.yBottom ?? 0) + o.height;
        if (
          state.x + state.baseWidth > o.x &&
          state.x < o.x + o.width &&
          yPrev >= oYTop &&
          state.y <= oYTop
        ) {
          state.y = oYTop;
          state.vy = 0;
          state.onGround = true;
          state.jumpsLeft = state.maxJumps;
          landedOnPlatform = true;
          break;
        }
      }
    }

    // (4) pit 판정 — 봇 y <= 0일 때 pit 위이면 낙사(무적 예외)
    let inPit = false;
    if (state.y <= 0) {
      for (const pit of track.pits) {
        if (state.x + state.baseWidth > pit.x && state.x < pit.x + pit.width) {
          inPit = true;
          break;
        }
      }
      if (inPit && isLastingImmuneForPit(state)) inPit = false;
    }

    if (!landedOnPlatform) {
      if (state.y <= 0 && !inPit) {
        state.y = 0;
        state.vy = 0;
        state.onGround = true;
        state.jumpsLeft = state.maxJumps;
      } else if (state.y < -100) {
        // 낙사 확정
        pitFell = true;
        state.alive = false;
        break;
      } else if (state.y > 0) {
        state.onGround = false;
      } else if (inPit) {
        // pit 안 y=0 도달 — 다음 tick부터 y 계속 감소 → 낙사
        state.onGround = false;
      }
    }

    // (5) 크기 결정 (거대화 우선, 슬라이드 다음)
    const giantActive = state.giantTicks > 0;
    const sliding = input.slide && state.onGround && !giantActive;
    if (giantActive) {
      state.width = state.baseWidth * GIANT_SCALE;
      state.height = state.baseHeight * GIANT_SCALE;
    } else if (sliding) {
      state.width = state.baseWidth;
      state.height = state.slideHeight;
    } else {
      state.width = state.baseWidth;
      state.height = state.baseHeight;
    }

    // (6) 무적 tick 감소
    if (state.invincibleTicks > 0) state.invincibleTicks--;
    if (state.giantTicks > 0) state.giantTicks--;
    if (state.itemDashTicks > 0) state.itemDashTicks--;
    if (state.magnetTicks > 0) state.magnetTicks--;

    // (7) 장애물 충돌 판정 — immune 아니면.
    // 옵션 B: 봇 지상 상태(walking) 충돌은 무시 — 실제 봇의 회피점프 로직이 발동해서 자연 회피.
    // 착지 시 가장 가까운 obstacle까지 여유 검사 — avoidMin 미달이면 회피 불가 →
    // 이후 walking 충돌도 count (unsafeAfterLanding=true).
    // 공중 충돌은 실제 사고 (arc가 obstacle 통과) → 항상 count.
    const justLanded = yPrev > 0 && state.onGround;
    if (justLanded && !landingChecked) {
      landingChecked = true;
      const botRight = state.x + state.baseWidth;
      let nearestObstacleX = Infinity;
      let nearestIsHigh = false;
      for (const o of track.obstacles) {
        if (o.kind === "platform") continue;
        if ((o.yBottom ?? 0) > 0) continue;
        if (o.x + o.width <= botRight) continue;
        if (o.x < nearestObstacleX) {
          nearestObstacleX = o.x;
          nearestIsHigh = o.height > 100;
        }
      }
      if (nearestObstacleX !== Infinity) {
        const distance = nearestObstacleX - botRight;
        const avoidMinSec = nearestIsHigh ? 80 / 300 : 20 / 300;
        const avoidMin = avoidMinSec * effSpeed;
        if (distance < avoidMin) unsafeAfterLanding = true;
      }
    }
    const checkCollision =
      !isSimImmune(state) &&
      (!state.onGround || justLanded || unsafeAfterLanding);
    if (checkCollision) {
      for (const o of track.obstacles) {
        if (o.kind === "platform") continue;
        const oYBottom = o.yBottom ?? 0;
        const oYTop = oYBottom + o.height;
        if (
          state.x + state.width > o.x &&
          state.x < o.x + o.width &&
          state.y < oYTop &&
          state.y + state.height > oYBottom
        ) {
          collisionCount++;
          state.invincibleTicks = INVINCIBLE_TICKS;
          break;
        }
      }
    }

    // (8) 자석 흡수 — 활성 시 범위 안 아이템 수집
    if (state.magnetTicks > 0) {
      const cx = state.x + state.width / 2;
      const cy = state.y + state.height / 2;
      const r2 = MAGNET_RANGE * MAGNET_RANGE;
      for (const it of track.items) {
        const key = it.fromNext ? it.index + 100000 : it.index;
        if (collectedStaticThisSim.has(key)) continue;
        const dx = it.x - cx;
        const dy = it.y - cy;
        if (dx * dx + dy * dy <= r2) {
          collectedStaticThisSim.add(key);
          itemsScore += itemScore(it);
        }
      }
      for (const sp of spawned) {
        if (collectedSpawnThisSim.has(sp.idx)) continue;
        const dx = sp.x - cx;
        const dy = sp.y - cy;
        if (dx * dx + dy * dy <= r2) {
          collectedSpawnThisSim.add(sp.idx);
          itemsScore += itemScore(sp);
        }
      }
    }

    // (9) 박스 수집 — 봇 몸통 안 아이템
    for (const it of track.items) {
      const key = it.fromNext ? it.index + 100000 : it.index;
      if (collectedStaticThisSim.has(key)) continue;
      if (
        it.x >= state.x &&
        it.x <= state.x + state.width &&
        it.y >= state.y &&
        it.y <= state.y + state.height
      ) {
        collectedStaticThisSim.add(key);
        itemsScore += itemScore(it);
      }
    }
    for (const sp of spawned) {
      if (collectedSpawnThisSim.has(sp.idx)) continue;
      if (
        sp.x >= state.x &&
        sp.x <= state.x + state.width &&
        sp.y >= state.y &&
        sp.y <= state.y + state.height
      ) {
        collectedSpawnThisSim.add(sp.idx);
        itemsScore += itemScore(sp);
      }
    }
  }

  const score =
    itemsScore +
    (pitFell ? PIT_PENALTY : 0) +
    collisionCount * COLLISION_PENALTY;

  return {
    score,
    details: {
      itemsCaughtScore: itemsScore,
      collisionCount,
      pitFell,
      finalX: state.x,
      finalY: state.y,
      ticksSimulated: simulated,
    },
  };
}
