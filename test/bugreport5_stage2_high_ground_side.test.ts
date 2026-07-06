// BugReport #5 재현 — stage2-jumps, default+destroyer, 장비 없음.
// 두 시드 모두 h=150 세로벽(width=50) 옆면 충돌:
//   #1: seed 311701551, tick 468 근처, x=2340 vs 장애물 x=2369.97
//   #2: seed 1747332858, tick 1344 근처, x=2620 vs 장애물 x=2647.77
// 공통: onGround=T, jL=2, invincibleTicks=60 (직전 피격), 장애물 코앞 약 28~30픽셀.

import { describe, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import defaultChar from "../src/data/characters/hwangtae.json";
import destroyerPet from "../src/data/pets/nurungji.json";
import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const loadout: Loadout = {
  character: defaultChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [],
};

function runCase(seed: number, targetX: number, maxTick: number) {
  const w = createWorld(seed, trackPool, loadout);
  console.log(
    `\n=== seed ${seed} 시작 트랙 id=${w.currentTrack.id} length=${w.currentTrack.length.toFixed(0)} ===`,
  );
  const buffer: string[] = [];
  const BUF_SIZE = 120;
  let tick = 0;
  let lastTrackId = w.currentTrack.id;
  let collided = false;
  let collidedTick = -1;

  while (w.runner.alive && tick < maxTick) {
    const r = w.runner;
    const input = decide(w);

    if (w.currentTrack.id !== lastTrackId) {
      console.log(`t=${tick} 트랙 전환 → ${w.currentTrack.id}`);
      lastTrackId = w.currentTrack.id;
    }

    const nearbyObs = w.currentTrack.obstacles
      .filter(
        (o, i) =>
          !w.destroyedObstacles[i] &&
          o.x + o.width > r.x - 100 &&
          o.x < r.x + 500,
      )
      .map((o) => {
        const yBot = o.yBottom ?? 0;
        const kind =
          o.kind === "platform"
            ? "P"
            : yBot > 0
              ? "C"
              : o.height === 150
                ? "H"
                : "L";
        return `${kind}[g${(o.x - r.x).toFixed(0)},h${o.height}${yBot > 0 ? ",yB" + yBot : ""}]`;
      })
      .join(",");

    const nearbyItems = w.currentTrack.items
      .map((it, i) => ({ it, collected: w.currentItemCollected[i] }))
      .filter(
        ({ it, collected }) =>
          !collected && it.x > r.x - 50 && it.x < r.x + 500,
      )
      .map(({ it }) => {
        const tag = it.effect ? it.effect[0]?.toUpperCase() : `c${it.value ?? 1}`;
        return `${tag}(g${(it.x - r.x).toFixed(0)},y${it.y.toFixed(0)})`;
      })
      .concat(
        w.spawnedItems
          .filter((sp) => !sp.collected && sp.x > r.x - 50 && sp.x < r.x + 500)
          .map((sp) => {
            const tag = sp.effect
              ? sp.effect[0]?.toUpperCase() + "*"
              : `c${sp.value ?? 1}*`;
            return `${tag}(g${(sp.x - r.x).toFixed(0)},y${sp.y.toFixed(0)})`;
          }),
      )
      .join(",");

    const line =
      `t=${tick.toString().padStart(4)} ` +
      `x=${r.x.toFixed(0).padStart(5)} y=${r.y.toFixed(1).padStart(6)} ` +
      `vy=${r.vy.toFixed(0).padStart(5)} onG=${r.onGround ? "T" : "F"} ` +
      `jL=${r.jumpsLeft} hp=${r.hp.toFixed(0).padStart(3)} inv=${r.invincibleTicks.toString().padStart(2)} ` +
      `in=(j=${input.jump ? "T" : "F"} s=${input.slide ? "T" : "F"} why=${input.debugReason ?? "?"}) ` +
      `obs:${nearbyObs} items:${nearbyItems}`;
    buffer.push(line);
    if (buffer.length > BUF_SIZE) buffer.shift();

    step(w, input);
    tick++;
    if (w.lastCollision && !collided) {
      collided = true;
      collidedTick = tick;
      console.log(
        `\n=== 충돌 발생 t=${tick} — ${JSON.stringify(w.lastCollision)} hp=${w.runner.hp.toFixed(1)} runnerX=${w.runner.x.toFixed(1)} targetX≈${targetX} ===`,
      );
      break;
    }
  }

  console.log(`\n--- seed ${seed} 사망 직전 ${buffer.length} tick ---`);
  for (const l of buffer) console.log(l);
  console.log(
    `\n종료: t=${tick} x=${w.runner.x.toFixed(1)} y=${w.runner.y.toFixed(1)} hp=${w.runner.hp.toFixed(1)} alive=${w.runner.alive} collidedTick=${collidedTick}`,
  );
}

describe("BugReport #5 stage2-jumps 고벽 옆면 충돌", () => {
  it("case #1: seed 311701551 (tick 468 근처, x=2340)", () => {
    runCase(311701551, 2340, 700);
  });

  it("case #2: seed 1747332858 (tick 1344 근처, x=2620)", () => {
    runCase(1747332858, 2620, 1600);
  });
});
