// 세션 20260711 사용자 케이스 회귀 test.
// 원본 봇: pri=5 (3079,80) 잡느라 궤도 확장 → 지면 (3268,0) v=20 놓침.
// bot.ts 궤도 시뮬 스코어링 fix로 봇이 walking 유지 → v=20 자연 수집.
// 이 test가 실패하면 봇 결정 로직에서 catch/skip 스코어링 부분 회귀 의심.

import { describe, it, expect } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import type { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import type { Stage } from "../src/sim/stage";
import hwangtae from "../src/data/characters/hwangtae.json";
import geumbungeo from "../src/data/pets/geumbungeo.json";
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

const LOADOUT: Loadout = {
  character: hwangtae as CharacterSpec,
  pet: geumbungeo as PetSpec,
  equipment: [
    coinRing as EquipmentSpec,
    coinRing as EquipmentSpec,
    coinRing as EquipmentSpec,
  ],
};

const SEED = 1887212460;
const TARGET_X = 3268;
const TARGET_Y = 0;
const TARGET_VALUE = 20;

type ItemSnapshot = { x: number; y: number; value?: number; collected: boolean };

function matches(it: ItemSnapshot): boolean {
  return (
    Math.abs(it.x - TARGET_X) < 5 &&
    it.y === TARGET_Y &&
    (it.value ?? 0) === TARGET_VALUE
  );
}

describe("사용자 케이스 회귀 (시드 1887212460 v=20)", () => {
  it("황태+금붕어+코인반지×3에서 (3268,0) v=20 코인 자연 수집", () => {
    const w = createWorld(SEED, trackPool, LOADOUT);

    // 트랙 wrap 시 currentItemCollected·spawnedItems가 새 트랙으로 리셋되므로
    // wrap 직전 상태를 매 tick 갱신해서 잠금.
    let snapshotBeforeWrap: ItemSnapshot[] | null = null;
    let snapshotLocked = false;

    let tick = 0;
    while (w.runner.alive && tick < 3000) {
      const input = decide(w);

      // 매 tick 이전 트랙 아이템 상태 갱신 (아직 wrap 전에만).
      // td 6500~7100 범위에서만 갱신 (사용자 케이스가 이 구간에 있음).
      const td = w.runner.totalDistance;
      if (!snapshotLocked && td >= 6500 && td <= 7100) {
        const cur = w.currentTrack;
        const collected: ItemSnapshot[] = [];
        for (let i = 0; i < cur.items.length; i++) {
          const it = cur.items[i]!;
          collected.push({
            x: it.x,
            y: it.y,
            value: it.value,
            collected: w.currentItemCollected[i]!,
          });
        }
        for (const sp of w.spawnedItems) {
          collected.push({ x: sp.x, y: sp.y, value: sp.value, collected: sp.collected });
        }
        snapshotBeforeWrap = collected;
      }

      const preTrackId = w.currentTrack.id;
      step(w, input);
      tick++;

      // wrap 감지되면 이전 트랙 스냅샷 잠금.
      if (w.currentTrack.id !== preTrackId && snapshotBeforeWrap) {
        snapshotLocked = true;
      }
    }

    // 스냅샷 없으면 현재 트랙에서 탐색 (wrap 전에 목표 지점 지나감).
    const searchSpace: ItemSnapshot[] = snapshotBeforeWrap ?? (() => {
      const cur = w.currentTrack;
      const list: ItemSnapshot[] = [];
      for (let i = 0; i < cur.items.length; i++) {
        const it = cur.items[i]!;
        list.push({ x: it.x, y: it.y, value: it.value, collected: w.currentItemCollected[i]! });
      }
      for (const sp of w.spawnedItems) {
        list.push({ x: sp.x, y: sp.y, value: sp.value, collected: sp.collected });
      }
      return list;
    })();

    const target = searchSpace.find(matches);
    expect(target, `목표 (${TARGET_X},${TARGET_Y}) v=${TARGET_VALUE} 아이템을 트랙에서 찾지 못함 — 트랙 데이터·시드 변경 의심`).toBeDefined();
    expect(target!.collected, `봇이 (${TARGET_X},${TARGET_Y}) v=${TARGET_VALUE} 놓침 — 궤도 시뮬 스코어링 회귀`).toBe(true);
  });
});
