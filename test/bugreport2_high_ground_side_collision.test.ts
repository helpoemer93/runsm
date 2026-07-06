// BugReport #2 재현 — seed 293938927, default+destroyer+coin-ring×3.
// tick 395 stage4-mixed highGround (x=2002, w=50, h=150) 옆면 충돌.
// 마지막 점프 tick 339 x=1695 단점프 후 정점 이단점프 보충 실패 → 착지 후 walking → 옆면 충돌.

import { describe, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import defaultChar from "../src/data/characters/default.json";
import destroyerPet from "../src/data/pets/destroyer.json";
import coinRing from "../src/data/equipment/coin-ring.json";
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
  equipment: [coinRing, coinRing, coinRing] as EquipmentSpec[],
};

const SEED = 293938927;

describe("BugReport #2 highGround 옆면 충돌", () => {
  it("사망 직전 80 tick 로그", () => {
    const w = createWorld(SEED, trackPool, loadout);
    console.log(
      `초기 트랙 id=${w.currentTrack.id} length=${w.currentTrack.length.toFixed(0)}`,
    );
    const buffer: string[] = [];
    const BUF_SIZE = 100;
    let tick = 0;
    let lastTrackId = w.currentTrack.id;

    while (w.runner.alive && tick < 500) {
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
          return `${kind}[g${(o.x - r.x).toFixed(0)},h${o.height}]`;
        })
        .join(",");
      const nearbyPits = (w.currentTrack.pits ?? [])
        .filter((p) => p.x + p.width > r.x - 100 && p.x < r.x + 500)
        .map((p) => `pit[g${(p.x - r.x).toFixed(0)},w${p.width.toFixed(0)}]`)
        .join(",");

      const line =
        `t=${tick.toString().padStart(4)} ` +
        `x=${r.x.toFixed(0).padStart(5)} y=${r.y.toFixed(1).padStart(6)} ` +
        `vy=${r.vy.toFixed(0).padStart(5)} onG=${r.onGround ? "T" : "F"} ` +
        `jL=${r.jumpsLeft} hp=${r.hp.toFixed(0).padStart(3)} ` +
        `in=(j=${input.jump ? "T" : "F"} s=${input.slide ? "T" : "F"} why=${input.debugReason ?? "?"}) ` +
        `obs:${nearbyObs} ${nearbyPits} items:${
          w.currentTrack.items
            .map((it, i) => ({ it, collected: w.currentItemCollected[i] }))
            .filter(
              ({ it, collected }) =>
                !collected && it.x > r.x - 50 && it.x < r.x + 600,
            )
            .map(({ it }) => {
              const tag = it.effect ? it.effect[0]?.toUpperCase() : `c${it.value ?? 1}`;
              return `${tag}(g${(it.x - r.x).toFixed(0)},y${it.y.toFixed(0)})`;
            })
            .concat(
              w.spawnedItems
                .filter((sp) => !sp.collected && sp.x > r.x - 50 && sp.x < r.x + 600)
                .map((sp) => {
                  const tag = sp.effect
                    ? sp.effect[0]?.toUpperCase() + "*"
                    : `c${sp.value ?? 1}*`;
                  return `${tag}(g${(sp.x - r.x).toFixed(0)},y${sp.y.toFixed(0)})`;
                }),
            )
            .join(",")
        }`;
      buffer.push(line);
      if (buffer.length > BUF_SIZE) buffer.shift();

      step(w, input);
      tick++;
      if (w.lastCollision) {
        console.log(
          `t=${tick} 충돌 ${JSON.stringify(w.lastCollision)} hp=${w.runner.hp.toFixed(1)}`,
        );
      }
    }

    console.log(`\n=== 사망 직전 ${buffer.length} tick 로그 ===`);
    for (const l of buffer) console.log(l);
    console.log(
      `\n종료: t=${tick} x=${w.runner.x.toFixed(1)} y=${w.runner.y.toFixed(1)} hp=${w.runner.hp.toFixed(1)} alive=${w.runner.alive}`,
    );
  });
});
