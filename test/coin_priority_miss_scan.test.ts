// 코인 우선순위 오판 스캐너 —
// 봇이 보라 코인(v≥20) 놓친 근처(같은 트랙, x 거리 ±300px 이내)에서
// 주황 코인(5≤v<20) 또는 노랑 코인(v<5) 잡은 케이스 검출.
// 사용자 로컬 관찰 "보라 버리고 주황 먹음" 케이스 자동 진단용.
//
// 회귀 아님. 개별 실행: `npx vitest run test/coin_priority_miss_scan.test.ts`

import { describe, it } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import hwangtaeChar from "../src/data/characters/hwangtae.json";
import meruChar from "../src/data/characters/meru.json";
import nurungjiPet from "../src/data/pets/nurungji.json";
import geumbungeoPet from "../src/data/pets/geumbungeo.json";

import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

const SEED_START = 42;
const SEED_COUNT = 200;
const MAX_LAPS = 2;
const MAX_TICKS = 40000;
const NEARBY_X = 300; // 놓친 보라와 잡은 주황이 근처로 간주할 x 거리
const TOP_K = 15;

const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

interface Loadouts {
  label: string;
  loadout: Loadout;
}

const LOADOUTS: Loadouts[] = [
  {
    label: "hwangtae+nurungji",
    loadout: {
      character: hwangtaeChar as CharacterSpec,
      pet: nurungjiPet as PetSpec,
      equipment: [],
    },
  },
  {
    label: "meru+geumbungeo",
    loadout: {
      character: meruChar as CharacterSpec,
      pet: geumbungeoPet as PetSpec,
      equipment: [],
    },
  },
];

interface CoinEvent {
  tick: number;
  botX: number;
  botY: number;
  itemX: number;
  itemY: number;
  value: number;
  reason: string;
  trackId: string;
  lap: number;
}

interface MissCase {
  seed: number;
  loadout: string;
  missed: CoinEvent;
  caught: CoinEvent;
  gap: number;
  valueDiff: number;
}

// 봇이 잡음/놓침 확정 시점을 tick별로 감지.
function scanSeed(seed: number, loadout: Loadout, label: string): MissCase[] {
  const w = createWorld(seed, trackPool, loadout);
  const caughtOranges: CoinEvent[] = [];
  const missedPurples: CoinEvent[] = [];
  const passedSpawn = new Set<object>();
  let ticks = 0;

  while (w.runner.alive && w.runner.lap < MAX_LAPS && ticks < MAX_TICKS) {
    const input = decide(w);
    const reason = input.debugReason ?? "";
    const prevSpawnedCollected = w.spawnedItems.map((sp) => sp.collected);
    const prevSpawnedRefs = w.spawnedItems.slice();
    step(w, input);
    ticks++;

    const r = w.runner;
    const trackId = w.currentTrack.id;
    const lap = r.lap;

    // 이 tick에 새로 잡힌 spawn 코인 감지 (주황)
    // spawnedItems가 wrap 시 재생성되므로 이전 tick 배열과 참조 비교.
    for (let j = 0; j < prevSpawnedRefs.length; j++) {
      const sp = prevSpawnedRefs[j]!;
      // wrap 후엔 sp가 현재 배열에 없을 수도. sp 자체 collected 필드로 판정.
      if (!prevSpawnedCollected[j] && sp.collected) {
        if (sp.effect) continue;
        const v = sp.value ?? 1;
        if (v >= 5 && v < 20) {
          caughtOranges.push({
            tick: w.tick,
            botX: r.x,
            botY: r.y,
            itemX: sp.x,
            itemY: sp.y,
            value: v,
            reason,
            trackId,
            lap,
          });
        }
      }
    }

    // 봇이 지나쳐 미수집으로 확정된 spawn 코인 (놓친 보라)
    for (const sp of w.spawnedItems) {
      if (sp.collected) continue;
      if (r.x <= sp.x + 50) continue; // 아직 안 지남
      if (passedSpawn.has(sp)) continue;
      passedSpawn.add(sp);
      if (sp.effect) continue;
      const v = sp.value ?? 1;
      if (v >= 20) {
        missedPurples.push({
          tick: w.tick,
          botX: r.x,
          botY: r.y,
          itemX: sp.x,
          itemY: sp.y,
          value: v,
          reason,
          trackId,
          lap,
        });
      }
    }
  }

  // 매칭 — 같은 트랙·랩, x 거리 NEARBY_X 이내.
  const cases: MissCase[] = [];
  for (const missed of missedPurples) {
    for (const caught of caughtOranges) {
      if (missed.lap !== caught.lap) continue;
      if (missed.trackId !== caught.trackId) continue;
      const gap = Math.abs(missed.itemX - caught.itemX);
      if (gap > NEARBY_X) continue;
      cases.push({
        seed,
        loadout: label,
        missed,
        caught,
        gap,
        valueDiff: missed.value - caught.value,
      });
    }
  }
  return cases;
}

function fmt(e: CoinEvent): string {
  return `t${e.tick} 봇(${Math.round(e.botX)},${Math.round(e.botY)}) 아이템(${Math.round(e.itemX)},${e.itemY}) v=${e.value} 트랙=${e.trackId} lap=${e.lap} 판단=[${e.reason}]`;
}

describe("코인 우선순위 오판 스캐너 — 보라 놓치고 주황 잡은 케이스", () => {
  it(`${LOADOUTS.length}로드아웃 × ${SEED_COUNT}시드 스캔`, () => {
    const allCases: MissCase[] = [];
    const stats = new Map<
      string,
      { seeds: number; missedPurple: number; caughtOrange: number; cases: number }
    >();

    for (const { label, loadout } of LOADOUTS) {
      let missedTotal = 0;
      let caughtTotal = 0;
      let caseTotal = 0;
      for (let seedI = 0; seedI < SEED_COUNT; seedI++) {
        const seed = SEED_START + seedI * 997;
        const cases = scanSeed(seed, loadout, label);
        allCases.push(...cases);
        // 각 시드별 통계
        const w = createWorld(seed, trackPool, loadout);
        void w;
        caseTotal += cases.length;
      }
      // 시드 200개 스캔 후 개별 총량은 다시 계산
      for (const c of allCases) {
        if (c.loadout === label) {
          missedTotal++; // 개별 case별 놓친 카운트 (중복 매칭 포함)
        }
      }
      stats.set(label, {
        seeds: SEED_COUNT,
        missedPurple: 0,
        caughtOrange: 0,
        cases: caseTotal,
      });
    }

    // 심각도 순 (valueDiff↓, 다음 gap↑)
    allCases.sort((a, b) => {
      if (b.valueDiff !== a.valueDiff) return b.valueDiff - a.valueDiff;
      return a.gap - b.gap;
    });

    // 시드별 대표 케이스 1개씩만 (중복 매칭 제거)
    const seenSeed = new Set<string>();
    const uniq: MissCase[] = [];
    for (const c of allCases) {
      const key = `${c.seed}:${c.loadout}:${c.missed.tick}`;
      if (seenSeed.has(key)) continue;
      seenSeed.add(key);
      uniq.push(c);
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n=== 스캐너 요약 (${LOADOUTS.length}로드아웃 × ${SEED_COUNT}시드) ===`,
    );
    for (const [label, s] of stats) {
      // eslint-disable-next-line no-console
      console.log(`  ${label}: 케이스 ${s.cases}개`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n총 케이스 ${allCases.length}건 (시드별 중복 제거 후 ${uniq.length}건)\n`,
    );

    // eslint-disable-next-line no-console
    console.log(`=== TOP ${TOP_K} 심각 케이스 (valueDiff↓) ===`);
    for (let i = 0; i < Math.min(TOP_K, uniq.length); i++) {
      const c = uniq[i]!;
      // eslint-disable-next-line no-console
      console.log(
        `\n[${i + 1}] seed=${c.seed} loadout=${c.loadout} valueDiff=+${c.valueDiff} gap=${c.gap}px`,
      );
      // eslint-disable-next-line no-console
      console.log(`  놓친 보라: ${fmt(c.missed)}`);
      // eslint-disable-next-line no-console
      console.log(`  잡은 주황: ${fmt(c.caught)}`);
    }
  });
});
