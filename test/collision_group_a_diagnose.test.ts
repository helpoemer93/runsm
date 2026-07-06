// 그룹 A 재현 — seed 1559855750 stage3-slides tick 508 h=30 벽 우측 옆면 충돌.
// 여러 로드아웃 (기본+destroyer, 코인워커+destroyer, 기본+destroyer+코인링×3) 공통 실패.
// 목표: 봇 뛰기 tick·사유·gap 확인해서 궤도 판정 어긋난 지점 짚기.

import { describe, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import defaultChar from "../src/data/characters/default.json";
import destroyerPet from "../src/data/pets/destroyer.json";
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

const SEED = 1559855750;

describe("그룹 A seed 1559855750 하강 중 저벽 옆면", () => {
  it("사망 직전 100 tick 로그", () => {
    const w = createWorld(SEED, trackPool, loadout);
    console.log(`시작 트랙 id=${w.currentTrack.id} length=${w.currentTrack.length.toFixed(0)}`);
    const buffer: string[] = [];
    const BUF_SIZE = 100;
    let tick = 0;
    let lastTrackId = w.currentTrack.id;

    while (w.runner.alive && tick < 700) {
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
            o.x < r.x + 400,
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
          return `${kind}[g${(o.x - r.x).toFixed(0)},w${o.width},h${o.height}${yBot > 0 ? ",yB" + yBot : ""}]`;
        })
        .join(",");
      const items = w.currentTrack.items
        .map((it, i) => ({ it, collected: w.currentItemCollected[i] }))
        .filter(({ it, collected }) => !collected && it.x > r.x - 500 && it.x < r.x + 500)
        .map(({ it }) => {
          const tag = it.effect ? it.effect[0]?.toUpperCase() : `c${it.value ?? 1}`;
          return `${tag}(g${(it.x - r.x).toFixed(0)},y${it.y.toFixed(0)})`;
        })
        .concat(
          w.spawnedItems
            .filter((sp) => !sp.collected && sp.x > r.x - 500 && sp.x < r.x + 500)
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
        `obs:${nearbyObs} it:${items}`;
      buffer.push(line);
      if (buffer.length > BUF_SIZE) buffer.shift();
      step(w, input);
      tick++;
      if (w.lastCollision) {
        console.log(`\n=== 충돌 t=${tick} ${JSON.stringify(w.lastCollision)} hp=${w.runner.hp.toFixed(1)} runnerX=${w.runner.x.toFixed(1)} y=${w.runner.y.toFixed(1)} vy=${w.runner.vy.toFixed(0)} ===`);
        break;
      }
    }
    console.log(`\n--- 사망 직전 ${buffer.length} tick ---`);
    for (const l of buffer) console.log(l);
  });
});
