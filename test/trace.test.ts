// 한 사이클 봇 동작 트레이스 — effect 아이템 미스 + 충돌 자동 캡처.
// 일회성 분석 도구이므로 일반 회귀 테스트와 의도가 다름(평소 npm test 시 출력 noise 있음).
//
// 사용법:
//   1. LOADOUT을 분석 대상 봇 빌드로 변경
//   2. SEED_SCAN_START부터 SEED_SCAN_COUNT개 시드 시뮬 → 첫 충돌 발생 시드 자동 trace
//   3. 특정 시드 직접 분석하려면 findFirstCollisionSeed를 const SEED = <시드>로 교체

import { describe, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import defaultChar from "../src/data/characters/hwangtae.json";
import coinWalkerChar from "../src/data/characters/meru.json";
import destroyerPet from "../src/data/pets/nurungji.json";
import fireworkPet from "../src/data/pets/geumbungeo.json";
import shoes from "../src/data/equipment/shoes.json";
import healTalisman from "../src/data/equipment/heal-talisman.json";
import coinRing from "../src/data/equipment/coin-ring.json";

import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

// ── 트레이스 입력 ──────────────────────────────────────
// 충돌 발생 시드 찾기 모드 — SEED_SCAN_START부터 N개 시뮬해서 충돌 있는 첫 시드 분석
const SEED_SCAN_START = 1;
const SEED_SCAN_COUNT = 100;
const LOADOUT: Loadout = {
  character: defaultChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [shoes as EquipmentSpec, shoes as EquipmentSpec, shoes as EquipmentSpec],
};
const MAX_LAPS = 3;
const MAX_TICKS = 30000;
// ───────────────────────────────────────────────────────

// SEED는 describe 안에서 동적 계산 (trackPool 초기화 후)
let SEED = SEED_SCAN_START;

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];
// 사용 안 하는 spec import 묶음 — 향후 시드 분석 시 LOADOUT 변경 편하게.
void [defaultChar, fireworkPet, shoes, healTalisman, coinRing] as unknown as EquipmentSpec[];

function isWatched(item: { value?: number; effect?: string }): boolean {
  if (item.effect) return true;
  return (item.value ?? 1) >= 5;
}

interface MissEntry {
  tick: number;
  totalDist: number;
  trackId: string;
  src: "정적" | "spawn";
  itemX: number;
  itemY: number;
  kind: string;
  runnerX: number;
  runnerY: number;
  vy: number;
  onGround: boolean;
  jumpsLeft: number;
  invincibleTicks: number;
  immune: boolean;
}

interface CollisionEntry {
  tick: number;
  trackId: string;
  obstacleIdx: number;
  obstacleX: number;
  height: number;
  yBottom: number;
  runnerX: number;
  runnerY: number;
  hp: number;
  itemDashTicks: number;
  giantTicks: number;
  invincibleTicks: number;
  dashSkill: boolean;
  onGround: boolean;
}

function findFirstCollisionSeed(): number {
  for (let s = SEED_SCAN_START; s < SEED_SCAN_START + SEED_SCAN_COUNT; s++) {
    const w = createWorld(s, trackPool, LOADOUT);
    let t = 0;
    while (w.runner.alive && w.runner.lap < MAX_LAPS && t < MAX_TICKS) {
      step(w, decide(w));
      t++;
      if (w.lastCollision) return s;
    }
  }
  return SEED_SCAN_START;
}

describe("trace", () => {
  it(`충돌 시드 추적`, () => {
    SEED = findFirstCollisionSeed();
    const w = createWorld(SEED, trackPool, LOADOUT);
    const misses: MissEntry[] = [];
    const collisions: CollisionEntry[] = [];
    const jumps: { tick: number; totalDist: number; trackId: string; runnerX: number; runnerY: number; vy: number; type: string; itemDashTicks: number; giantTicks: number; dashSkill: boolean }[] = [];
    const seen = new Set<string>();
    const PASS_THRESHOLD = 30;

    let ticks = 0;
    let prevJumpsLeft = w.runner.jumpsLeft;
    while (w.runner.alive && w.runner.lap < MAX_LAPS && ticks < MAX_TICKS) {
      step(w, decide(w));
      ticks++;
      const r = w.runner;

      // 점프 감지 — jumpsLeft 감소 시점 캡처
      if (r.jumpsLeft < prevJumpsLeft) {
        const dashSkillActive = w.skills.some(
          (s) => s.activeTicks > 0 && s.spec.id === "dash",
        );
        jumps.push({
          tick: w.tick,
          totalDist: Math.round(r.totalDistance),
          trackId: w.currentTrack.id,
          runnerX: Math.round(r.x * 10) / 10,
          runnerY: Math.round(r.y * 10) / 10,
          vy: Math.round(r.vy),
          type: prevJumpsLeft === r.maxJumps ? "단점프" : "이단점프",
          itemDashTicks: r.itemDashTicks,
          giantTicks: r.giantTicks,
          dashSkill: dashSkillActive,
        });
      }
      prevJumpsLeft = r.jumpsLeft;

      if (w.lastCollision) {
        const o = w.currentTrack.obstacles[w.lastCollision.obstacleIdx];
        const dashSk = w.skills.some((s) => s.activeTicks > 0 && s.spec.id === "dash");
        collisions.push({
          tick: w.tick,
          trackId: w.currentTrack.id,
          obstacleIdx: w.lastCollision.obstacleIdx,
          obstacleX: o ? Math.round(o.x * 10) / 10 : -1,
          height: o?.height ?? -1,
          yBottom: o?.yBottom ?? 0,
          runnerX: Math.round(r.x * 10) / 10,
          runnerY: Math.round(r.y * 10) / 10,
          hp: Math.round(r.hp * 10) / 10,
          itemDashTicks: r.itemDashTicks,
          giantTicks: r.giantTicks,
          invincibleTicks: r.invincibleTicks,
          dashSkill: dashSk,
          onGround: r.onGround,
        });
      }

      const immune =
        r.invincibleTicks > 0 ||
        r.giantTicks > 0 ||
        r.itemDashTicks > 0 ||
        w.skills.some((s) => s.activeTicks > 0 && s.spec.id === "dash");

      const trackKey = `t${r.lap}`;
      for (let i = 0; i < w.currentTrack.items.length; i++) {
        if (w.currentItemCollected[i]) continue;
        const item = w.currentTrack.items[i]!;
        if (!isWatched(item)) continue;
        if (r.x > item.x + PASS_THRESHOLD) {
          const k = `${trackKey}:s:${i}`;
          if (!seen.has(k)) {
            seen.add(k);
            misses.push({
              tick: w.tick,
              totalDist: Math.round(r.totalDistance),
              trackId: w.currentTrack.id,
              src: "정적",
              itemX: Math.round(item.x * 10) / 10,
              itemY: item.y,
              kind: item.effect ?? `coin v=${item.value ?? 1}`,
              runnerX: Math.round(r.x * 10) / 10,
              runnerY: Math.round(r.y * 10) / 10,
              vy: Math.round(r.vy),
              onGround: r.onGround,
              jumpsLeft: r.jumpsLeft,
              invincibleTicks: r.invincibleTicks,
              immune,
            });
          }
        }
      }
      for (let j = 0; j < w.spawnedItems.length; j++) {
        const sp = w.spawnedItems[j]!;
        if (sp.collected) continue;
        if (!isWatched(sp)) continue;
        if (r.x > sp.x + PASS_THRESHOLD) {
          const k = `${trackKey}:d:${j}`;
          if (!seen.has(k)) {
            seen.add(k);
            misses.push({
              tick: w.tick,
              totalDist: Math.round(r.totalDistance),
              trackId: w.currentTrack.id,
              src: "spawn",
              itemX: Math.round(sp.x * 10) / 10,
              itemY: sp.y,
              kind: sp.effect ?? `coin v=${sp.value ?? 1}`,
              runnerX: Math.round(r.x * 10) / 10,
              runnerY: Math.round(r.y * 10) / 10,
              vy: Math.round(r.vy),
              onGround: r.onGround,
              jumpsLeft: r.jumpsLeft,
              invincibleTicks: r.invincibleTicks,
              immune,
            });
          }
        }
      }
    }

    const r = w.runner;
    const lines: string[] = [];
    lines.push("");
    lines.push(`=== 시드 ${SEED} (${LOADOUT.character.id}+${LOADOUT.pet?.id}) ===`);
    lines.push(
      `ticks=${ticks} laps=${r.lap} hp=${r.hp.toFixed(1)} coins=${r.coins} dist=${Math.round(r.totalDistance)}`,
    );
    lines.push(`충돌 ${collisions.length}건, 미스 ${misses.length}건`);

    if (jumps.length > 0) {
      lines.push("");
      lines.push("--- 점프 ---");
      for (const j of jumps) {
        lines.push(`t${j.tick} d=${j.totalDist} ${j.trackId} ${j.type} runner=(${j.runnerX},${j.runnerY}) vy=${j.vy} itemDash=${j.itemDashTicks} giant=${j.giantTicks} dashSkill=${j.dashSkill}`);
      }
    }
    if (collisions.length > 0) {
      lines.push("");
      lines.push("--- 충돌 ---");
      for (const c of collisions) {
        const kind = c.yBottom > 0 ? "ceiling" : "ground";
        const flags: string[] = [];
        if (c.dashSkill) flags.push("dashSkill");
        if (c.itemDashTicks > 0) flags.push(`itemDash=${c.itemDashTicks}`);
        if (c.giantTicks > 0) flags.push(`giant=${c.giantTicks}`);
        if (c.invincibleTicks > 0) flags.push(`invinc=${c.invincibleTicks}`);
        if (!c.onGround) flags.push("AIR");
        const flagStr = flags.length > 0 ? ` [${flags.join(" ")}]` : "";
        lines.push(
          `t${c.tick} ${c.trackId} ${kind} idx=${c.obstacleIdx} obs.x=${c.obstacleX} h=${c.height} yB=${c.yBottom} runner=(${c.runnerX},${c.runnerY}) hp=${c.hp}${flagStr}`,
        );
      }
    }
    if (misses.length > 0) {
      lines.push("");
      lines.push("--- 미스 ---");
      for (const m of misses) {
        lines.push(
          `t${m.tick} d=${m.totalDist} ${m.trackId} ${m.src} ${m.kind} item=(${m.itemX},${m.itemY}) runner=(${m.runnerX},${m.runnerY}) vy=${m.vy} ground=${m.onGround} jumps=${m.jumpsLeft} immune=${m.immune}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  });
});
