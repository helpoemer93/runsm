// BugReport #1 재현 — seed 776376923, default+destroyer, 장비 없음, 봇1(botIndex=1).
// tick 1283 stage2-jumps ceiling (x=2344, w=200, h=90, yBottom=30) 옆면 충돌.
// runCount 95 = 재출발 여러 번. 시드 자체는 사이클 seed. 마지막 이단점프 tick 1241 하강 중 재발동.

import { describe, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
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

const SEED = 776376923;

describe("BugReport #1 ceiling 옆면 충돌", () => {
  it("사망 직전 100 tick 로그", () => {
    const w = createWorld(SEED, trackPool, loadout);
    console.log(
      `초기 트랙 id=${w.currentTrack.id} length=${w.currentTrack.length.toFixed(0)}`,
    );
    const buffer: string[] = [];
    const BUF_SIZE = 100;
    let tick = 0;
    let lastTrackId = w.currentTrack.id;

    while (w.runner.alive && tick < 1500) {
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

      const line =
        `t=${tick.toString().padStart(4)} ` +
        `x=${r.x.toFixed(0).padStart(5)} y=${r.y.toFixed(1).padStart(6)} ` +
        `vy=${r.vy.toFixed(0).padStart(5)} onG=${r.onGround ? "T" : "F"} ` +
        `jL=${r.jumpsLeft} hp=${r.hp.toFixed(0).padStart(3)} ` +
        `in=(j=${input.jump ? "T" : "F"} s=${input.slide ? "T" : "F"} why=${input.debugReason ?? "?"}) ` +
        `obs:${nearbyObs}`;
      buffer.push(line);
      if (buffer.length > BUF_SIZE) buffer.shift();

      step(w, input);
      tick++;
      if (w.lastCollision) {
        console.log(
          `\n=== 충돌 발생 t=${tick} — ${JSON.stringify(w.lastCollision)} hp=${w.runner.hp.toFixed(1)} ===`,
        );
        break;
      }
    }

    console.log(`\n=== 사망 직전 ${buffer.length} tick 로그 ===`);
    for (const l of buffer) console.log(l);
    console.log(
      `\n종료: t=${tick} x=${w.runner.x.toFixed(1)} y=${w.runner.y.toFixed(1)} hp=${w.runner.hp.toFixed(1)} alive=${w.runner.alive}`,
    );
  });
});
