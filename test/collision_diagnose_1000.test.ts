// 1000판 시뮬 안 충돌 발생 케이스 시드·tick·obstacle·runner 상태 로그.
// collision_stats_1000의 결과가 34건이라 각각 재현 가능한 케이스 리스트 뽑기.

import { describe, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";
import { Rng } from "../src/sim/rng";

import defaultChar from "../src/data/characters/hwangtae.json";
import coinWalkerChar from "../src/data/characters/meru.json";
import destroyerPet from "../src/data/pets/nurungji.json";
import fireworkPet from "../src/data/pets/geumbungeo.json";
import shoesSpec from "../src/data/equipment/shoes.json";
import healTalismanSpec from "../src/data/equipment/heal-talisman.json";
import coinRingSpec from "../src/data/equipment/coin-ring.json";

import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

const SEED_START = 42;
const CYCLES_PER_LOADOUT = 1000;
const MAX_CYCLE_SECONDS = 120;

const defaultC = defaultChar as CharacterSpec;
const coinWalkerC = coinWalkerChar as CharacterSpec;
const destroyer = destroyerPet as PetSpec;
const firework = fireworkPet as PetSpec;
const shoes = shoesSpec as EquipmentSpec;
const healTalisman = healTalismanSpec as EquipmentSpec;
const coinRing = coinRingSpec as EquipmentSpec;

interface BenchLoadout {
  label: string;
  loadout: Loadout;
}

const LOADOUTS: BenchLoadout[] = [
  { label: "기본+destroyer", loadout: { character: defaultC, pet: destroyer, equipment: [] } },
  { label: "기본+firework", loadout: { character: defaultC, pet: firework, equipment: [] } },
  { label: "코인워커+destroyer", loadout: { character: coinWalkerC, pet: destroyer, equipment: [] } },
  { label: "코인워커+firework", loadout: { character: coinWalkerC, pet: firework, equipment: [] } },
  { label: "기본+destroyer+신발×3", loadout: { character: defaultC, pet: destroyer, equipment: [shoes, shoes, shoes] } },
  { label: "기본+destroyer+회복부적×3", loadout: { character: defaultC, pet: destroyer, equipment: [healTalisman, healTalisman, healTalisman] } },
  { label: "기본+destroyer+코인링×3", loadout: { character: defaultC, pet: destroyer, equipment: [coinRing, coinRing, coinRing] } },
];

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const MAX_CYCLE_TICKS = Math.round(MAX_CYCLE_SECONDS / TICK_DURATION);

interface CollisionCase {
  loadoutLabel: string;
  cycleIdx: number;
  seed: number;
  tick: number;
  trackId: string;
  runnerX: number;
  runnerY: number;
  runnerVy: number;
  runnerOnGround: boolean;
  runnerJumpsLeft: number;
  runnerHp: number;
  runnerInvBefore: number; // 충돌 직전 invincibleTicks (fatal 판정용)
  obstacleIdx: number;
  obstacleX: number;
  obstacleW: number;
  obstacleH: number;
  obstacleYBottom: number;
  fatal: boolean; // 이 충돌로 사망
}

function runAndCollect(bl: BenchLoadout): CollisionCase[] {
  const rng = new Rng(SEED_START);
  const cases: CollisionCase[] = [];

  for (let i = 0; i < CYCLES_PER_LOADOUT; i++) {
    const seed = rng.nextInt(0, 0x7fffffff);
    const w = createWorld(seed, trackPool, bl.loadout);
    let ticks = 0;
    let lastCollisionTick = -1;
    while (w.runner.alive && ticks < MAX_CYCLE_TICKS) {
      const invBefore = w.runner.invincibleTicks;
      step(w, decide(w));
      ticks++;
      if (w.lastCollision && ticks !== lastCollisionTick) {
        lastCollisionTick = ticks;
        const oIdx = w.lastCollision.obstacleIdx;
        const o = w.currentTrack.obstacles[oIdx]!;
        cases.push({
          loadoutLabel: bl.label,
          cycleIdx: i,
          seed,
          tick: ticks,
          trackId: w.currentTrack.id,
          runnerX: Math.round(w.runner.x * 10) / 10,
          runnerY: Math.round(w.runner.y * 10) / 10,
          runnerVy: Math.round(w.runner.vy),
          runnerOnGround: w.runner.onGround,
          runnerJumpsLeft: w.runner.jumpsLeft,
          runnerHp: Math.round(w.runner.hp * 10) / 10,
          runnerInvBefore: invBefore,
          obstacleIdx: oIdx,
          obstacleX: Math.round(o.x * 10) / 10,
          obstacleW: o.width,
          obstacleH: o.height,
          obstacleYBottom: o.yBottom ?? 0,
          fatal: !w.runner.alive,
        });
      }
    }
  }
  return cases;
}

describe("1000판 충돌 케이스 목록", () => {
  it(
    `${LOADOUTS.length}개 로드아웃 × ${CYCLES_PER_LOADOUT}판`,
    () => {
      const all: CollisionCase[] = [];
      for (const bl of LOADOUTS) {
        const cases = runAndCollect(bl);
        for (const c of cases) all.push(c);
      }

      const lines: string[] = [];
      lines.push("");
      lines.push(`=== 총 충돌 ${all.length}건 ===`);
      lines.push("");
      lines.push("로드아웃 | cycle | seed | tick | 트랙 | runner(x,y,vy,onG,jL,hp,invB) | obs(idx,x,w,h,yBottom) | fatal");
      lines.push("-".repeat(140));
      for (const c of all) {
        lines.push(
          `${c.loadoutLabel} | #${c.cycleIdx} | ${c.seed} | ${c.tick} | ${c.trackId} | ` +
            `(x=${c.runnerX},y=${c.runnerY},vy=${c.runnerVy},onG=${c.runnerOnGround ? "T" : "F"},jL=${c.runnerJumpsLeft},hp=${c.runnerHp},invB=${c.runnerInvBefore}) | ` +
            `(idx=${c.obstacleIdx},x=${c.obstacleX},w=${c.obstacleW},h=${c.obstacleH},yB=${c.obstacleYBottom}) | ${c.fatal ? "FATAL" : "-"}`,
        );
      }

      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
    },
    10 * 60 * 1000,
  );
});
