// 무작위 시드 하나 돌려보고 봇 판단 훑기 — "실수" 후보 짚기용.
// 로드아웃 고정 default+destroyer+coin-ring×3. 시드는 임의(수정 자유).
// 출력: 트랙 전환·점프 tick(사유 포함)·충돌·hp 감소·놓친 가치 아이템·요약 통계.

import { describe, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import defaultChar from "../src/data/characters/hwangtae.json";
import destroyerPet from "../src/data/pets/nurungji.json";
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

const SEED = 736305561;
const MAX_TICKS = 3000;

describe("무작위 시드 봇 판단 훑기", () => {
  it(`시드 ${SEED} 사이클 진단`, () => {
    const w = createWorld(SEED, trackPool, loadout);
    console.log(
      `\n=== 시드 ${SEED} / 로드아웃 default+destroyer+coin-ring×3 ===`,
    );
    console.log(
      `초기 트랙 id=${w.currentTrack.id} length=${w.currentTrack.length.toFixed(0)}`,
    );

    interface JumpEvent {
      tick: number;
      x: number;
      y: number;
      vy: number;
      jLBefore: number;
      why: string;
    }
    interface CollisionEvent {
      tick: number;
      obstacleIdx: number;
      x: number;
      y: number;
      hpAfter: number;
    }
    interface HpDropEvent {
      tick: number;
      x: number;
      from: number;
      to: number;
      cause: string;
    }
    const jumps: JumpEvent[] = [];
    const collisions: CollisionEvent[] = [];
    const hpDrops: HpDropEvent[] = [];

    let lastTrackId = w.currentTrack.id;
    let lastHp = w.runner.hp;
    let tick = 0;

    while (w.runner.alive && tick < MAX_TICKS) {
      const r = w.runner;
      const input = decide(w);

      if (w.currentTrack.id !== lastTrackId) {
        console.log(
          `[트랙 전환] t=${tick} → ${w.currentTrack.id} (완주)`,
        );
        lastTrackId = w.currentTrack.id;
      }

      const prevJumps = r.jumpsLeft;
      step(w, input);
      if (w.runner.jumpsLeft < prevJumps) {
        jumps.push({
          tick,
          x: Math.round(r.x),
          y: Math.round(r.y * 10) / 10,
          vy: Math.round(r.vy),
          jLBefore: prevJumps,
          why: input.debugReason ?? "?",
        });
      }
      if (w.lastCollision) {
        collisions.push({
          tick,
          obstacleIdx: w.lastCollision.obstacleIdx,
          x: Math.round(r.x),
          y: Math.round(r.y * 10) / 10,
          hpAfter: Math.round(w.runner.hp * 10) / 10,
        });
      }
      const hpNow = w.runner.hp;
      if (hpNow < lastHp - 0.5) {
        const drop = lastHp - hpNow;
        const cause = w.lastCollision
          ? `충돌 obstacleIdx=${w.lastCollision.obstacleIdx}`
          : "시간/기타";
        // 시간 데미지는 매 tick 미세하니 5 이상 감소만 이벤트로.
        if (drop >= 5) {
          hpDrops.push({
            tick,
            x: Math.round(r.x),
            from: Math.round(lastHp * 10) / 10,
            to: Math.round(hpNow * 10) / 10,
            cause,
          });
        }
      }
      lastHp = hpNow;
      tick++;
    }

    // 놓친 가치 아이템 — 사이클 종료 시점 spawnedItems·정적 items 중 봇이 지난 것.
    // 좌표 매칭 issue 있으니 대략적. v>=5 or effect만 "가치".
    const missedValuable: string[] = [];
    for (let i = 0; i < w.currentTrack.items.length; i++) {
      const it = w.currentTrack.items[i]!;
      if (w.currentItemCollected[i]) continue;
      const isVal = it.effect !== undefined || (it.value ?? 1) >= 5;
      if (!isVal) continue;
      // 봇이 이 트랙 안에서 x가 아이템 x를 지났으면 놓친 것.
      if (w.currentTrackStart + it.x < w.runner.totalDistance - 10) {
        const kind = it.effect ?? `c${it.value ?? 1}`;
        missedValuable.push(
          `정적 ${kind} @ track_x=${it.x.toFixed(0)} y=${it.y.toFixed(0)}`,
        );
      }
    }
    for (const sp of w.spawnedItems) {
      if (sp.collected) continue;
      const isVal = sp.effect !== undefined || (sp.value ?? 1) >= 5;
      if (!isVal) continue;
      if (w.currentTrackStart + sp.x < w.runner.totalDistance - 10) {
        const kind = sp.effect ?? `c${sp.value ?? 1}`;
        missedValuable.push(
          `spawn ${kind} @ track_x=${sp.x.toFixed(0)} y=${sp.y.toFixed(0)}`,
        );
      }
    }

    console.log(
      `\n[종료] t=${tick} x=${w.runner.x.toFixed(0)} y=${w.runner.y.toFixed(1)} hp=${w.runner.hp.toFixed(1)} alive=${w.runner.alive} 총거리=${w.runner.totalDistance.toFixed(0)}`,
    );

    // === 점프 목록 ===
    console.log(`\n=== 점프 ${jumps.length}회 ===`);
    // why별 개수 통계
    const whyCount = new Map<string, number>();
    for (const j of jumps) whyCount.set(j.why, (whyCount.get(j.why) ?? 0) + 1);
    for (const [why, cnt] of [...whyCount.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${why}: ${cnt}회`);
    }
    console.log(`\n--- 점프 상세 (tick / 사유 / 상태) ---`);
    for (const j of jumps) {
      const type = j.jLBefore === w.runner.maxJumps ? "단" : "이단";
      console.log(
        `  t=${j.tick.toString().padStart(4)} ${type} why=${j.why.padEnd(20)} x=${j.x.toString().padStart(5)} y=${j.y.toString().padStart(6)} vy=${j.vy.toString().padStart(5)}`,
      );
    }

    // === 충돌·hp 손실 ===
    if (collisions.length > 0) {
      console.log(`\n=== 충돌 ${collisions.length}회 ===`);
      for (const c of collisions) {
        console.log(
          `  t=${c.tick} obstacleIdx=${c.obstacleIdx} x=${c.x} y=${c.y} hp→${c.hpAfter}`,
        );
      }
    }
    if (hpDrops.length > 0) {
      console.log(`\n=== hp 큰 감소 ${hpDrops.length}회 (>=5) ===`);
      for (const h of hpDrops) {
        console.log(
          `  t=${h.tick} x=${h.x} hp ${h.from}→${h.to} (${h.cause})`,
        );
      }
    }

    // === 놓친 가치 아이템 ===
    console.log(
      `\n=== 놓친 가치 아이템 (v>=5 or effect) ${missedValuable.length}개 ===`,
    );
    for (const m of missedValuable) console.log(`  ${m}`);
  });
});
