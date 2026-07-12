// 25건 유형 회귀 검증 — 대표 시드 3개(301327858, 899409168, 10408783)에서
// 충돌이 발생 안 하는지 확인.
// 원인: 스코어러가 magnet/heal 잡으려고 옆면 충돌 감수하던 결정을 무적 아이템만 허용으로 제한.
// fix 이전: 이 시드들에서 t=280~330 부근 옆면 충돌 발생.
// fix 이후: 신발×3 lv20/lv30 각 로드아웃 조합에서 초반 500 tick 안 충돌 없어야 함.

import { describe, it, expect } from "vitest";
import { createWorld, step } from "../src/sim/world";
import { decide } from "../src/sim/bot";
import type { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import type { Stage } from "../src/sim/stage";
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
const LOADOUTS: { name: string; loadout: Loadout }[] = [
  {
    name: "머루+신발lv20",
    loadout: { character: meru as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes20, shoes20, shoes20] },
  },
  {
    name: "황태+신발lv20",
    loadout: { character: hwangtae as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes20, shoes20, shoes20] },
  },
  {
    name: "머루+신발lv30",
    loadout: { character: meru as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes30, shoes30, shoes30] },
  },
  {
    name: "황태+신발lv30",
    loadout: { character: hwangtae as CharacterSpec, pet: nurungji as PetSpec, equipment: [shoes30, shoes30, shoes30] },
  },
];

// 25건 유형 대표 시드 (사망 아닌 충돌 케이스, 100000판 벤치 결과에서 추출).
const REPRESENTATIVE_SEEDS = [301327858, 899409168, 10408783];
const UP_TO_TICK = 500;

describe("25건 유형 회귀 (스코어러 무적 아이템만 충돌 감수)", () => {
  for (const seed of REPRESENTATIVE_SEEDS) {
    for (const { name, loadout } of LOADOUTS) {
      it(`시드 ${seed} × ${name} — 초반 ${UP_TO_TICK} tick 충돌 없음`, () => {
        const w = createWorld(seed, trackPool, loadout);
        let ticks = 0;
        let collisions = 0;
        while (w.runner.alive && ticks < UP_TO_TICK) {
          step(w, decide(w));
          ticks++;
          if (w.lastCollision) collisions++;
        }
        expect(collisions, `봇이 초반 ${UP_TO_TICK} tick 안 옆면 충돌 발생 — 스코어러가 비무적 아이템 잡으려고 충돌 감수 회귀`).toBe(0);
      });
    }
  }
});
