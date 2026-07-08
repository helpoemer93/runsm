// speed-shoes lv30 × 3 극단 세팅에서 stage2-jumps 초반 봇이 회피 판단 자체를 안 하고
// 첫 장애물 옆면 충돌 → 사망 시나리오 재현.
// 에러리포트 시드:
//   1019497837 (meru+nurungji, 신규)
//   1892863280 (default/destroyer, 이름 개편 이전 세션이라 로드아웃 재구성 필요)

import { describe, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import meruChar from "../src/data/characters/meru.json";
import hwangtaeChar from "../src/data/characters/hwangtae.json";
import nurungjiPet from "../src/data/pets/nurungji.json";
import shoesBase from "../src/data/equipment/shoes.json";
import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

function applyEnhance(base: EquipmentSpec, level: number): EquipmentSpec {
  if (level <= 0 || !base.enhanceDelta) return base;
  const d = base.enhanceDelta;
  const eff: EquipmentSpec = { id: base.id, name: base.name };
  if (base.runSpeedMult !== undefined || d.runSpeedMult)
    eff.runSpeedMult = (base.runSpeedMult ?? 1) + (d.runSpeedMult ?? 0) * level;
  return eff;
}

const shoes30 = applyEnhance(shoesBase as EquipmentSpec, 30);
const shoes100 = applyEnhance(shoesBase as EquipmentSpec, 100);
const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const MAX_TICKS = 200;

function runCase(label: string, seed: number, loadout: Loadout) {
  const w = createWorld(seed, trackPool, loadout);
  const r = w.runner;
  const initialSpeed = r.baseRunSpeed;
  const firstTrackId = w.currentTrack.id;

  // 초기 장애물 미리 훑기 — 어떤 obstacle이 x 몇에 있는지.
  const obstacles = w.currentTrack.obstacles.slice(0, 5).map((o) => ({
    x: o.x,
    w: o.width,
    h: o.height,
    kind: o.kind,
    yBottom: o.yBottom ?? 0,
  }));
  const pits = (w.currentTrack.pits ?? []).slice(0, 3);

  // eslint-disable-next-line no-console
  console.log(
    `\n[${label}] seed=${seed} character=${loadout.character.id} pet=${loadout.pet?.id ?? "(none)"}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `  effSpeed=${initialSpeed} px/s (=${(initialSpeed / 60).toFixed(2)} px/tick)`,
  );
  // eslint-disable-next-line no-console
  console.log(`  첫 트랙 id=${firstTrackId}, length=${w.currentTrack.length}`);
  // eslint-disable-next-line no-console
  console.log(`  초기 장애물 5개: ${JSON.stringify(obstacles)}`);
  if (pits.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`  초기 pit: ${JSON.stringify(pits)}`);
  }

  const AVOID_HIGH_MIN_SEC = 80 / 300;
  const AVOID_HIGH_MAX_SEC = 130 / 300;
  const AVOID_LOW_MIN_SEC = 20 / 300;
  const AVOID_LOW_MAX_SEC = 70 / 300;

  let collisionTick = -1;
  let collidedObs: (typeof obstacles)[number] | null = null;
  let botXAtCollision = -1;
  const decisionLog: {
    tick: number;
    rx: number;
    ry: number;
    reason: string;
    firstObsGap: number | null;
  }[] = [];

  for (let t = 0; t < MAX_TICKS && r.alive; t++) {
    const input = decide(w);
    // 이 tick 시점 첫 (봇 앞) high obstacle과의 gap
    let firstObsGap: number | null = null;
    for (const o of w.currentTrack.obstacles) {
      const oYBottom = (o as any).yBottom ?? 0;
      if (oYBottom > 0) continue;
      if (o.kind === "platform") continue;
      const gap = o.x - (r.x + r.width);
      if (gap > 0) {
        firstObsGap = gap;
        break;
      }
    }
    decisionLog.push({
      tick: w.tick,
      rx: Math.round(r.x * 10) / 10,
      ry: Math.round(r.y * 10) / 10,
      reason: input.debugReason ?? "",
      firstObsGap: firstObsGap === null ? null : Math.round(firstObsGap * 10) / 10,
    });
    step(w, input);
    if (w.lastCollision && collisionTick < 0) {
      collisionTick = w.tick;
      botXAtCollision = r.x;
      // 어떤 obstacle에 부딪혔는지 찾기
      for (const o of w.currentTrack.obstacles) {
        if (
          r.x + r.baseWidth > o.x &&
          r.x < o.x + o.width &&
          r.y < ((o as any).yBottom ?? 0) + o.height
        ) {
          collidedObs = {
            x: o.x,
            w: o.width,
            h: o.height,
            kind: o.kind,
            yBottom: (o as any).yBottom ?? 0,
          };
          break;
        }
      }
    }
    if (!r.alive) break;
  }

  // eslint-disable-next-line no-console
  console.log(`  결과: alive=${r.alive} coins=${r.coins} hp=${r.hp}`);
  if (collisionTick >= 0) {
    // eslint-disable-next-line no-console
    console.log(
      `  첫 충돌 t=${collisionTick} 봇 x=${botXAtCollision.toFixed(1)} 대상=${JSON.stringify(collidedObs)}`,
    );
    const s = initialSpeed;
    // eslint-disable-next-line no-console
    console.log(
      `  회피 트리거 zone (high) = ${(AVOID_HIGH_MIN_SEC * s).toFixed(1)}~${(AVOID_HIGH_MAX_SEC * s).toFixed(1)}px`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `  회피 트리거 zone (low)  = ${(AVOID_LOW_MIN_SEC * s).toFixed(1)}~${(AVOID_LOW_MAX_SEC * s).toFixed(1)}px`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`  판단 로그 (첫 ${decisionLog.length} tick):`);
  for (const d of decisionLog) {
    // eslint-disable-next-line no-console
    console.log(
      `    t${d.tick} x=${d.rx} y=${d.ry} reason=[${d.reason}] firstObsGap=${d.firstObsGap}`,
    );
  }
}

describe("speed-shoes lv30 × 3 극단 세팅 회피 실패 재현", () => {
  it("seed 1019497837 meru + nurungji", () => {
    runCase("meru+nurungji", 1019497837, {
      character: meruChar as CharacterSpec,
      pet: nurungjiPet as PetSpec,
      equipment: [shoes30, shoes30, shoes30],
    });
  });
  it("seed 1892863280 hwangtae (default 대체) + nurungji", () => {
    runCase("hwangtae+nurungji", 1892863280, {
      character: hwangtaeChar as CharacterSpec,
      pet: nurungjiPet as PetSpec,
      equipment: [shoes30, shoes30, shoes30],
    });
  });
  it("[가상 시뮬] shoes+100 × 3 seed 1019497837 meru + nurungji", () => {
    runCase("meru+nurungji shoes+100×3", 1019497837, {
      character: meruChar as CharacterSpec,
      pet: nurungjiPet as PetSpec,
      equipment: [shoes100, shoes100, shoes100],
    });
  });
});
