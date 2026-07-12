// 신발 극단 세팅 20000판 벤치 — 충돌 발생 시점의 (장애물 유형, 봇 상태, debugReason)
// 튜플로 분류·집계. 커밋 5618a4b(스코어러 무적 아이템만 충돌 감수 허용) 이후
// 남은 충돌 8건이 어느 유형인지 확인용.
//
// 실행 시간 ≈ 10분. CI 대상 아님 — 명시적으로 실행:
//   npx vitest run test/shoes_extreme_reclassify_scan.test.ts

import { describe, it } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import type { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import type { Stage } from "../src/sim/stage";
import { Rng } from "../src/sim/rng";
import hwangtae from "../src/data/characters/hwangtae.json";
import meru from "../src/data/characters/meru.json";
import nurungji from "../src/data/pets/nurungji.json";
import shoesBase from "../src/data/equipment/shoes.json";
import stage1 from "../src/data/stages/stage1.json";
import stage2 from "../src/data/stages/stage2.json";
import stage3 from "../src/data/stages/stage3.json";
import stage4 from "../src/data/stages/stage4.json";

function applyEnhance(base: EquipmentSpec, level: number): EquipmentSpec {
  if (level <= 0 || !base.enhanceDelta) return base;
  const d = base.enhanceDelta;
  const eff: EquipmentSpec = { id: base.id, name: base.name };
  if (base.runSpeedMult !== undefined || d.runSpeedMult)
    eff.runSpeedMult = (base.runSpeedMult ?? 1) + (d.runSpeedMult ?? 0) * level;
  return eff;
}
const shoes20 = applyEnhance(shoesBase as EquipmentSpec, 20);
const shoes30 = applyEnhance(shoesBase as EquipmentSpec, 30);
const trackPool: Stage[] = [
  stage1 as Stage,
  stage2 as Stage,
  stage3 as Stage,
  stage4 as Stage,
];

const LOADOUTS: { label: string; loadout: Loadout }[] = [
  {
    label: "머루lv20",
    loadout: { character: meru as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes20, shoes20, shoes20] },
  },
  {
    label: "황태lv20",
    loadout: { character: hwangtae as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes20, shoes20, shoes20] },
  },
  {
    label: "머루lv30",
    loadout: { character: meru as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes30, shoes30, shoes30] },
  },
  {
    label: "황태lv30",
    loadout: { character: hwangtae as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes30, shoes30, shoes30] },
  },
];

const SEED_START = 42;
const CYCLES_PER_LOADOUT = 5000;
const MAX_CYCLE_SECONDS = 120;
const MAX_CYCLE_TICKS = Math.round(MAX_CYCLE_SECONDS / TICK_DURATION);

interface CollisionRecord {
  loadout: string;
  seed: number;
  tick: number;
  botX: number;
  botY: number;
  botVy: number;
  onGround: boolean;
  hp: number;
  obsX: number;
  obsW: number;
  obsH: number;
  obsYBottom: number;
  debugReason: string;
  died: boolean;
}

// 장애물 유형 문자열
function obstacleTag(rec: CollisionRecord): string {
  if (rec.obsYBottom > 0) return `천장(yB${rec.obsYBottom},h${rec.obsH})`;
  return `지면(h${rec.obsH})`;
}

// 봇 상태 문자열
function botStateTag(rec: CollisionRecord): string {
  if (rec.onGround) return "지상";
  if (rec.botVy < -20) return "상승";
  if (rec.botVy > 20) return "하강";
  return "정점";
}

function pad(s: string, n: number): string {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}

describe("신발 극단 세팅 20000판 재분류 스캔", () => {
  it(
    `4 로드아웃 × ${CYCLES_PER_LOADOUT}판 충돌 유형 집계`,
    () => {
      const records: CollisionRecord[] = [];

      for (const bl of LOADOUTS) {
        const rng = new Rng(SEED_START);
        for (let i = 0; i < CYCLES_PER_LOADOUT; i++) {
          const seed = rng.nextInt(0, 0x7fffffff);
          const w = createWorld(seed, trackPool, bl.loadout);
          let tick = 0;
          let lastInputReason = "?";
          while (w.runner.alive && tick < MAX_CYCLE_TICKS) {
            const input = decide(w);
            lastInputReason = input.debugReason ?? "?";
            const rBeforeX = w.runner.x;
            const rBeforeY = w.runner.y;
            const rBeforeVy = w.runner.vy;
            const rBeforeOnG = w.runner.onGround;
            const rBeforeHp = w.runner.hp;
            step(w, input);
            tick++;
            if (w.lastCollision) {
              const o = w.currentTrack.obstacles[w.lastCollision.obstacleIdx];
              if (o) {
                records.push({
                  loadout: bl.label,
                  seed,
                  tick,
                  botX: rBeforeX,
                  botY: rBeforeY,
                  botVy: rBeforeVy,
                  onGround: rBeforeOnG,
                  hp: rBeforeHp,
                  obsX: o.x,
                  obsW: o.width,
                  obsH: o.height,
                  obsYBottom: o.yBottom ?? 0,
                  debugReason: lastInputReason,
                  died: !w.runner.alive,
                });
              }
            }
          }
        }
      }

      // 유형별 집계
      const typeMap = new Map<string, CollisionRecord[]>();
      for (const rec of records) {
        const key = `${obstacleTag(rec)} / ${botStateTag(rec)} / ${rec.debugReason}`;
        const arr = typeMap.get(key) ?? [];
        arr.push(rec);
        typeMap.set(key, arr);
      }
      const sortedTypes = Array.from(typeMap.entries()).sort(
        (a, b) => b[1].length - a[1].length,
      );

      const lines: string[] = [];
      lines.push("");
      lines.push(
        `=== 신발 극단 세팅 20000판 재분류 (시작 시드=${SEED_START}) ===`,
      );
      lines.push("");
      lines.push(`총 충돌 이벤트: ${records.length} (사망 ${records.filter((r) => r.died).length})`);
      lines.push("");
      lines.push("--- 유형별 집계 ---");
      const header = pad("건수", 6) + pad("사망", 6) + "유형";
      lines.push(header);
      lines.push("-".repeat(80));
      for (const [key, arr] of sortedTypes) {
        const deathCount = arr.filter((r) => r.died).length;
        lines.push(pad(arr.length.toString(), 6) + pad(deathCount.toString(), 6) + key);
      }
      lines.push("");
      lines.push("--- 유형별 대표 시드 (앞 3건) ---");
      for (const [key, arr] of sortedTypes) {
        lines.push(`[${key}] (${arr.length}건)`);
        for (const rec of arr.slice(0, 3)) {
          lines.push(
            `  ${rec.loadout} seed=${rec.seed} t=${rec.tick} ` +
              `봇(${rec.botX.toFixed(0)},${rec.botY.toFixed(1)}) vy=${rec.botVy.toFixed(0)} ` +
              `onG=${rec.onGround ? "T" : "F"} hp=${rec.hp.toFixed(0)} ` +
              `obs(x=${rec.obsX.toFixed(0)},yB=${rec.obsYBottom},h=${rec.obsH}) ` +
              `${rec.died ? "사망" : "생존"}`,
          );
        }
      }
      lines.push("");
      lines.push("--- 로드아웃별 요약 ---");
      const loHeader = pad("로드아웃", 12) + pad("충돌", 6) + "사망";
      lines.push(loHeader);
      lines.push("-".repeat(loHeader.length + 4));
      for (const bl of LOADOUTS) {
        const rs = records.filter((r) => r.loadout === bl.label);
        const ds = rs.filter((r) => r.died).length;
        lines.push(pad(bl.label, 12) + pad(rs.length.toString(), 6) + ds.toString());
      }
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
    },
    15 * 60 * 1000,
  );
});
