// obstacle 충돌사망 원인 진단 — 신발×3 로드아웃에서 collision 사망 발생 시드 찾고
// 사망 직전 봇 상태 시퀀스 로그. 일회성 진단 도구.

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

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const loadout: Loadout = {
  character: defaultChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [shoesSpec, shoesSpec, shoesSpec] as EquipmentSpec[],
};

const SEED_START = 42;
const MAX_MEASUREMENTS = 50;
const DURATION_SEC = 300;
const DEATH_PENALTY_SEC = 5;
const MAX_TICKS_PER_MEASUREMENT = Math.round(DURATION_SEC / TICK_DURATION);
const DEATH_PENALTY_TICKS = Math.round(DEATH_PENALTY_SEC / TICK_DURATION);
const LOG_BUFFER_SIZE = 80;

describe("obstacle 충돌사망 진단", () => {
  it("신발×3 첫 collision 사망 케이스 사망 전 로그", () => {
    const outerRng = new Rng(SEED_START);
    let foundCycleSeed = -1;
    let foundMeasurement = -1;
    let foundCycle = -1;

    for (let m = 0; m < MAX_MEASUREMENTS && foundCycleSeed < 0; m++) {
      const measurementSeed = outerRng.nextInt(0, 0x7fffffff);
      const innerRng = new Rng(measurementSeed);
      let elapsedTicks = 0;
      let c = 0;
      while (elapsedTicks < MAX_TICKS_PER_MEASUREMENT && foundCycleSeed < 0) {
        const cycleSeed = innerRng.nextInt(0, 0x7fffffff);
        const w = createWorld(cycleSeed, trackPool, loadout);
        let cycleTicks = 0;
        while (
          w.runner.alive &&
          elapsedTicks + cycleTicks < MAX_TICKS_PER_MEASUREMENT
        ) {
          step(w, decide(w));
          cycleTicks++;
        }
        // collision 사망만 잡음
        if (!w.runner.alive && w.lastCollision) {
          foundCycleSeed = cycleSeed;
          foundMeasurement = m;
          foundCycle = c;
          break;
        }
        elapsedTicks += cycleTicks;
        if (!w.runner.alive) elapsedTicks += DEATH_PENALTY_TICKS;
        c++;
      }
    }

    if (foundCycleSeed < 0) {
      console.log("collision 사망 케이스 없음");
      return;
    }

    console.log(
      `측정 #${foundMeasurement}, 사이클 #${foundCycle}, cycleSeed=${foundCycleSeed}에서 첫 collision 사망`,
    );

    // 재시뮬 로그
    const w = createWorld(foundCycleSeed, trackPool, loadout);
    const buffer: string[] = [];
    let tick = 0;

    while (w.runner.alive) {
      const input = decide(w);
      const r = w.runner;
      const pits = w.currentTrack.pits ?? [];
      const nearbyPits = pits
        .filter((p) => p.x + p.width > r.x - 200 && p.x < r.x + 500)
        .map(
          (p) =>
            `[${p.x.toFixed(0)}~${(p.x + p.width).toFixed(0)}(폭${p.width.toFixed(0)})]`,
        )
        .join(",");
      const nearbyObs = w.currentTrack.obstacles
        .filter(
          (_, i) =>
            !w.destroyedObstacles[i] &&
            w.currentTrack.obstacles[i]!.x + w.currentTrack.obstacles[i]!.width >
              r.x - 100 &&
            w.currentTrack.obstacles[i]!.x < r.x + 400,
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
          return `${kind}[${o.x.toFixed(0)}~${(o.x + o.width).toFixed(0)},h${o.height}]`;
        })
        .join(",");
      const staticItems = w.currentTrack.items
        .map((it, i) => ({ it, collected: w.currentItemCollected[i] }))
        .filter(
          ({ it, collected }) =>
            !collected && it.x > r.x - 50 && it.x < r.x + 300,
        );
      const spawnItems = w.spawnedItems.filter(
        (sp) => !sp.collected && sp.x > r.x - 50 && sp.x < r.x + 300,
      );
      const itemStr = [
        ...staticItems.map(({ it }) => {
          const gap = (it.x - r.x).toFixed(0);
          const tag = it.effect
            ? it.effect[0]?.toUpperCase()
            : `c${it.value ?? 1}`;
          return `${tag}(g${gap},y${it.y.toFixed(0)})`;
        }),
        ...spawnItems.map((sp) => {
          const gap = (sp.x - r.x).toFixed(0);
          const tag = sp.effect
            ? sp.effect[0]?.toUpperCase() + "*"
            : `c${sp.value ?? 1}*`;
          return `${tag}(g${gap},y${sp.y.toFixed(0)})`;
        }),
      ].join(",");

      const line =
        `t=${tick.toString().padStart(4)} ` +
        `x=${r.x.toFixed(0).padStart(5)} y=${r.y.toFixed(1).padStart(6)} ` +
        `vy=${r.vy.toFixed(0).padStart(5)} onG=${r.onGround ? "T" : "F"} ` +
        `jL=${r.jumpsLeft} hp=${r.hp.toFixed(0).padStart(3)} ` +
        `inv=${r.invincibleTicks.toString().padStart(2)} ` +
        `dashItem=${r.itemDashTicks} giant=${r.giantTicks} ` +
        `input=(j=${input.jump ? "T" : "F"} s=${input.slide ? "T" : "F"} why=${input.debugReason ?? "?"}) ` +
        `pit:${nearbyPits} obs:${nearbyObs} items:${itemStr}`;
      buffer.push(line);
      if (buffer.length > LOG_BUFFER_SIZE) buffer.shift();

      step(w, input);
      tick++;
    }

    console.log(`=== 사망 시점 t=${tick} (마지막 ${buffer.length} tick) ===`);
    for (const l of buffer) console.log(l);
    console.log(
      `사망 원인: collision=${w.lastCollision ? JSON.stringify(w.lastCollision) : "no"}, pitFall=${w.lastPitFall}, hp=${w.runner.hp.toFixed(1)}`,
    );
    console.log(
      `봇 최종 상태: x=${w.runner.x.toFixed(1)} y=${w.runner.y.toFixed(1)} vy=${w.runner.vy.toFixed(1)}`,
    );
    if (w.lastCollision) {
      const o = w.currentTrack.obstacles[w.lastCollision.obstacleIdx];
      if (o) {
        console.log(
          `충돌한 장애물: idx=${w.lastCollision.obstacleIdx} x=${o.x.toFixed(0)} width=${o.width} height=${o.height} yBottom=${o.yBottom ?? 0} kind=${o.kind ?? "block"}`,
        );
      }
    }
  });
});
