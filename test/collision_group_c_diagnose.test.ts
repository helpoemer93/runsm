// 그룹 C 재현 — 신발×3 트랙 시작 직후 h=150 벽 옆면 (FATAL).
// seed 1520937095 cycleIdx 571 or seed 2066557580 cycleIdx 777.
// 봇 x=0 트랙 시작에서 x=180 사이에 h=150 벽 → 반응 늦음.

import { describe, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";
import { Rng } from "../src/sim/rng";

import defaultChar from "../src/data/characters/hwangtae.json";
import destroyerPet from "../src/data/pets/nurungji.json";
import shoesSpec from "../src/data/equipment/shoes.json";
import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

const trackPool: Stage[] = [stage1 as Stage, stage2 as Stage, stage3 as Stage, stage4 as Stage];

const loadout: Loadout = {
  character: defaultChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [shoesSpec as EquipmentSpec, shoesSpec as EquipmentSpec, shoesSpec as EquipmentSpec],
};

// collision_stats에서 사용한 것과 같은 rng 시퀀스로 cycleIdx 571의 cycleSeed 획득.
function reproduceCycle(cycleIdx: number): number {
  const rng = new Rng(42);
  let seed = 0;
  for (let i = 0; i <= cycleIdx; i++) seed = rng.nextInt(0, 0x7fffffff);
  return seed;
}

function runCase(cycleIdx: number, label: string) {
    const seed = reproduceCycle(cycleIdx);
    console.log(`시드 ${seed}`);
    const w = createWorld(seed, trackPool, loadout);
    console.log(`시작 트랙 id=${w.currentTrack.id} obs=${w.currentTrack.obstacles.slice(0, 3).map((o) => `${o.kind ?? "block"}[x=${o.x.toFixed(0)},w=${o.width},h=${o.height},yB=${o.yBottom ?? 0}]`).join(",")}`);
    const buffer: string[] = [];
    const BUF_SIZE = 40;
    let tick = 0;
    let lastTrackId = w.currentTrack.id;
    while (w.runner.alive && tick < 3000) {
      const r = w.runner;
      const input = decide(w);
      if (w.currentTrack.id !== lastTrackId) {
        console.log(`t=${tick} 트랙 → ${w.currentTrack.id} obs=${w.currentTrack.obstacles.slice(0, 3).map((o) => `${o.kind ?? "block"}[x=${o.x.toFixed(0)},w=${o.width},h=${o.height}]`).join(",")}`);
        lastTrackId = w.currentTrack.id;
      }
      const nearbyObs = w.currentTrack.obstacles
        .filter((o, i) => !w.destroyedObstacles[i] && o.x + o.width > r.x - 50 && o.x < r.x + 500)
        .map((o) => {
          const yBot = o.yBottom ?? 0;
          const kind = o.kind === "platform" ? "P" : yBot > 0 ? "C" : o.height === 150 ? "H" : "L";
          return `${kind}[g${(o.x - r.x).toFixed(0)},h${o.height}]`;
        })
        .join(",");
      const line =
        `t=${tick.toString().padStart(4)} x=${r.x.toFixed(1).padStart(6)} y=${r.y.toFixed(1).padStart(5)} ` +
        `vy=${r.vy.toFixed(0).padStart(4)} onG=${r.onGround ? "T" : "F"} jL=${r.jumpsLeft} hp=${r.hp.toFixed(1)} inv=${r.invincibleTicks.toString().padStart(2)} ` +
        `in=(j=${input.jump ? "T" : "F"} why=${input.debugReason ?? "?"}) obs:${nearbyObs}`;
      buffer.push(line);
      if (buffer.length > BUF_SIZE) buffer.shift();
      step(w, input);
      tick++;
      if (w.lastCollision) {
        console.log(`\n=== 충돌 t=${tick} ${JSON.stringify(w.lastCollision)} hp=${w.runner.hp.toFixed(1)} x=${w.runner.x.toFixed(1)} y=${w.runner.y.toFixed(1)} ===`);
        break;
      }
    }
    console.log(`\n--- ${label} 사망 직전 ${buffer.length} tick ---`);
    for (const l of buffer) console.log(l);
}

describe("그룹 C 남은 사망 케이스", () => {
  it("cycleIdx 242 (신발×3 h=30)", () => runCase(242, "cycle 242"));
  it("cycleIdx 527 (신발×3 h=30)", () => runCase(527, "cycle 527"));
  it("cycleIdx 687 (신발×3 h=30)", () => runCase(687, "cycle 687"));
});
