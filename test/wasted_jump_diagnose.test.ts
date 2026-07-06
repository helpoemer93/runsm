// 봇 쓸데없는 점프 진단 — 특정 시드에서 회복/큰코인 놓치는 tick 앞뒤 로그.
// 사용자 보고: 시드 1032013380, 코인반지×3 + default + destroyer,
//   누적거리 3000 이내에서 쓸데없는 점프로 회복 아이템과 주황 코인(coin20) 놓침.
// 목적: 놓친 아이템 후보(회복·큰코인)를 봇 x가 지나친 시점을 잡고,
//   그 앞뒤 판단 사유/입력을 찍어서 어느 분기에서 오판했는지 짚기.

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

const SEED = 1032013380;
const MAX_DISTANCE = 15000;

describe("쓸데없는 점프 진단", () => {
  it("시드 1032013380 누적거리 3000 이내 회복/큰코인 놓친 지점 로그", () => {
    const w = createWorld(SEED, trackPool, loadout);
    console.log(
      `초기 트랙 id=${w.currentTrack.id} length=${w.currentTrack.length.toFixed(0)}`,
    );

    interface Snapshot {
      tick: number;
      totalDist: number;
      x: number;
      y: number;
      vy: number;
      onGround: boolean;
      jumpsLeft: number;
      hp: number;
      inputJump: boolean;
      inputSlide: boolean;
      reason: string;
      nearby: string;
    }

    const history: Snapshot[] = [];
    // 놓친 아이템 tick 표시용 — {trackId, itemIdx}로 정적 아이템 식별. spawned는 인덱스 기반.
    interface MissEvent {
      tick: number;
      kind: string;
      x: number;
      y: number;
      note: string;
    }
    const misses: MissEvent[] = [];
    const jumpEvents: number[] = []; // 점프 발동 tick

    let tick = 0;
    let lastTrackId = w.currentTrack.id;
    let trackStart = w.currentTrackStart;

    while (w.runner.alive && w.runner.totalDistance < MAX_DISTANCE) {
      const r = w.runner;
      const input = decide(w);

      // 트랙 전환 로그
      if (w.currentTrack.id !== lastTrackId) {
        console.log(
          `t=${tick} 트랙 전환 → id=${w.currentTrack.id} start=${w.currentTrackStart.toFixed(0)}`,
        );
        lastTrackId = w.currentTrack.id;
        trackStart = w.currentTrackStart;
      }

      // 근처 아이템·장애물 요약 — 봇 gap -50 ~ +400
      const staticItems = w.currentTrack.items
        .map((it, i) => ({ it, collected: w.currentItemCollected[i] }))
        .filter(
          ({ it, collected }) =>
            !collected && it.x > r.x - 50 && it.x < r.x + 400,
        )
        .map(({ it }) => {
          const gap = (it.x - r.x).toFixed(0);
          const tag = it.effect ? it.effect[0]?.toUpperCase() : `c${it.value ?? 1}`;
          return `${tag}(g${gap},y${it.y.toFixed(0)})`;
        });
      const spawnItems = w.spawnedItems
        .filter((sp) => !sp.collected && sp.x > r.x - 50 && sp.x < r.x + 400)
        .map((sp) => {
          const gap = (sp.x - r.x).toFixed(0);
          const tag = sp.effect
            ? sp.effect[0]?.toUpperCase() + "*"
            : `c${sp.value ?? 1}*`;
          return `${tag}(g${gap},y${sp.y.toFixed(0)})`;
        });
      const nearbyItems = [...staticItems, ...spawnItems].join(",");

      const nearbyObs = w.currentTrack.obstacles
        .filter(
          (o, i) =>
            !w.destroyedObstacles[i] &&
            o.x + o.width > r.x - 50 &&
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
          return `${kind}[g${(o.x - r.x).toFixed(0)},h${o.height}]`;
        })
        .join(",");
      const nearbyPits = (w.currentTrack.pits ?? [])
        .filter((p) => p.x + p.width > r.x - 50 && p.x < r.x + 400)
        .map(
          (p) =>
            `pit[g${(p.x - r.x).toFixed(0)},w${p.width.toFixed(0)}]`,
        )
        .join(",");

      history.push({
        tick,
        totalDist: r.totalDistance,
        x: r.x,
        y: r.y,
        vy: r.vy,
        onGround: r.onGround,
        jumpsLeft: r.jumpsLeft,
        hp: r.hp,
        inputJump: input.jump,
        inputSlide: input.slide,
        reason: input.debugReason ?? "?",
        nearby: `obs:${nearbyObs} pit:${nearbyPits} items:${nearbyItems}`,
      });

      // 점프 발동 감지 (jumpsLeft 감소)
      const prevJumps = r.jumpsLeft;
      step(w, input);
      if (w.runner.jumpsLeft < prevJumps) jumpEvents.push(tick);

      // 놓친 아이템 감지 — 이 tick에 봇 x가 특정 아이템 x를 넘긴 순간 collected 여부 확인.
      // 다만 collect는 봇 x가 아이템에 도달했을 때 진행 방향으로 판정하므로,
      // 봇 x가 아이템 x + item.width/gap 이상 지났는데 여전히 collected=false면 놓친 것.
      for (let i = 0; i < w.currentTrack.items.length; i++) {
        const it = w.currentTrack.items[i]!;
        if (w.currentItemCollected[i]) continue;
        const absX = trackStart + it.x;
        if (r.x + 20 > absX && r.x - 30 < absX) {
          // 봇 x가 방금 지나쳤는데 아직 미수집. 다음 tick도 미수집으로 남으면 확정.
          // 여기선 아이템 종류만 저장하고 최종 확정은 사이클 끝난 뒤.
        }
      }
      tick++;
    }

    // 놓친 아이템 최종 확정 — 봇이 지나친 정적 아이템 중 미수집인 것.
    for (let i = 0; i < w.currentTrack.items.length; i++) {
      const it = w.currentTrack.items[i]!;
      if (w.currentItemCollected[i]) continue;
      const absX = trackStart + it.x;
      if (absX < w.runner.x - 10) {
        const kind = it.effect ?? `c${it.value ?? 1}`;
        misses.push({
          tick: -1,
          kind,
          x: absX,
          y: it.y,
          note: "정적",
        });
      }
    }
    for (const sp of w.spawnedItems) {
      if (sp.collected) continue;
      if (sp.x < w.runner.x - 10) {
        const kind = sp.effect ?? `c${sp.value ?? 1}`;
        misses.push({
          tick: -1,
          kind,
          x: sp.x,
          y: sp.y,
          note: "spawn",
        });
      }
    }

    console.log(
      `\n=== 종료: t=${tick}, totalDist=${w.runner.totalDistance.toFixed(0)}, x=${w.runner.x.toFixed(0)}, alive=${w.runner.alive} ===`,
    );
    console.log(`점프 발동 tick 목록: ${jumpEvents.join(",")}`);
    console.log(`\n=== 놓친 아이템 (${misses.length}개) ===`);
    for (const m of misses) {
      // 놓친 아이템 근처 tick 찾기 — 봇 x가 그 아이템 x 근처였던 시점.
      const near = history.find((h) => Math.abs(h.x - m.x) < 30);
      const t = near ? near.tick : "?";
      console.log(
        `  [${m.note}] ${m.kind} @ x=${m.x.toFixed(0)} y=${m.y.toFixed(0)} (t≈${t})`,
      );
    }

    // 회복(heal) + 주황 코인(c5, value=5) 놓친 것 근처 로그.
    // (게임 UI 색상 매핑: c1=노랑, c5=주황, c20=보라)
    const importantMisses = misses.filter(
      (m) => m.kind === "heal" || m.kind === "c5",
    );
    console.log(
      `\n=== 중요 놓친 아이템 (heal/c5=주황) ${importantMisses.length}개, 각 앞뒤 tick 로그 ===`,
    );
    for (const m of importantMisses) {
      const near = history.findIndex((h) => Math.abs(h.x - m.x) < 30);
      if (near < 0) {
        console.log(`  [${m.kind} @ x=${m.x.toFixed(0)}] 근처 tick 못 찾음`);
        continue;
      }
      const start = Math.max(0, near - 20);
      const end = Math.min(history.length - 1, near + 10);
      console.log(
        `\n--- ${m.kind} @ x=${m.x.toFixed(0)} y=${m.y.toFixed(0)} 근처 (t=${history[start]!.tick}~${history[end]!.tick}) ---`,
      );
      for (let k = start; k <= end; k++) {
        const h = history[k]!;
        const marker = k === near ? " ← 아이템 x" : "";
        const jumpMark = jumpEvents.includes(h.tick) ? " *점프*" : "";
        console.log(
          `t=${h.tick.toString().padStart(4)} d=${h.totalDist.toFixed(0).padStart(5)} ` +
            `x=${h.x.toFixed(0).padStart(5)} y=${h.y.toFixed(1).padStart(6)} ` +
            `vy=${h.vy.toFixed(0).padStart(5)} onG=${h.onGround ? "T" : "F"} ` +
            `jL=${h.jumpsLeft} ` +
            `in=(j=${h.inputJump ? "T" : "F"} s=${h.inputSlide ? "T" : "F"} why=${h.reason})${jumpMark}${marker}\n` +
            `        ${h.nearby}`,
        );
      }
    }
  });
});
