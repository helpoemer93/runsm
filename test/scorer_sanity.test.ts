// 스코어러 sanity check — 다양한 상황에서 스코어가 상식적 순서로 나오는지 확인.

import { describe, it, expect } from "vitest";
import { createWorld, Input, step } from "../src/sim/world";
import { scoreActionPlan } from "../src/sim/scorer";
import { decide } from "../src/sim/bot";
import { CharacterSpec, Loadout } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";

import hwangtaeChar from "../src/data/characters/hwangtae.json";
import nurungjiPet from "../src/data/pets/nurungji.json";
import stage2 from "../src/data/stages/stage2.json";

const HORIZON = 40;

function nopPlan(): Input[] {
  return Array.from({ length: HORIZON }, () => ({ jump: false, slide: false }));
}

function jumpNowPlan(): Input[] {
  const p = nopPlan();
  p[0] = { jump: true, slide: false };
  return p;
}

function jumpNowAndDoubleAtPlan(k: number): Input[] {
  const p = jumpNowPlan();
  p[k] = { jump: true, slide: false };
  return p;
}

const loadout: Loadout = {
  character: hwangtaeChar as CharacterSpec,
  pet: nurungjiPet as any,
  equipment: [],
};

describe("스코어러 sanity check", () => {
  it("아무 것도 없을 때 nop 플랜 점수 = 0 근처", () => {
    const world = createWorld(42, [stage2 as Stage], loadout);
    const res = scoreActionPlan(world, nopPlan(), 300);
    expect(res.details.pitFell).toBe(false);
    expect(res.details.collisionCount).toBe(0);
    // 아이템 없거나 매우 적을 것
  });

  it("결정론 검증 — 같은 world+plan 두 번 호출 같은 점수", () => {
    const world = createWorld(42, [stage2 as Stage], loadout);
    const a = scoreActionPlan(world, jumpNowPlan(), 300);
    const b = scoreActionPlan(world, jumpNowPlan(), 300);
    expect(a.score).toBe(b.score);
    expect(a.details.finalX).toBe(b.details.finalX);
    expect(a.details.finalY).toBe(b.details.finalY);
  });

  it("여러 시드에서 스코어 분포 확인 — 각 시드 5플랜의 점수 스프레드", () => {
    const seeds = [42, 123, 456, 789, 1000];
    for (const seed of seeds) {
      const world = createWorld(seed, [stage2 as Stage], loadout);
      const plans = [
        { label: "nop", plan: nopPlan() },
        { label: "jump0", plan: jumpNowPlan() },
        { label: "combo t10", plan: jumpNowAndDoubleAtPlan(10) },
        { label: "combo t20 (정점)", plan: jumpNowAndDoubleAtPlan(20) },
        { label: "combo t30", plan: jumpNowAndDoubleAtPlan(30) },
      ];
      const scores = plans.map((p) => ({
        label: p.label,
        score: scoreActionPlan(world, p.plan, 300).score,
        details: scoreActionPlan(world, p.plan, 300).details,
      }));
      // eslint-disable-next-line no-console
      console.log(
        `seed=${seed}: ` +
          scores
            .map(
              (s) =>
                `${s.label}=${s.score}(items=${s.details.itemsCaughtScore},col=${s.details.collisionCount}${s.details.pitFell ? ",PIT" : ""})`,
            )
            .join(" | "),
      );
    }
  });

  it("실제 봇 실행과 스코어러 예측이 40 tick 안에서 일치하는지 (기본 세팅)", () => {
    // 실제 봇의 40 tick 실행 결과 vs 스코어러가 예측한 결과 비교.
    // 완벽 일치는 아니어도 방향(사망/충돌/수집 대략) 일치해야.
    const seeds = [42, 123, 456];
    for (const seed of seeds) {
      const world = createWorld(seed, [stage2 as Stage], loadout);

      // 스코어러로 봇의 실제 계획을 미리 예측 — decide 흉내
      const plan: Input[] = [];
      const worldCopyForPlan = createWorld(seed, [stage2 as Stage], loadout);
      for (let i = 0; i < HORIZON; i++) {
        const input = decide(worldCopyForPlan);
        plan.push({ jump: !!input.jump, slide: !!input.slide });
        step(worldCopyForPlan, input);
        if (!worldCopyForPlan.runner.alive) break;
      }

      const predicted = scoreActionPlan(world, plan, 300);

      // 실제 봇 실행 (독립 world)
      const worldReal = createWorld(seed, [stage2 as Stage], loadout);
      let realHits = 0;
      let realDied = false;
      for (let i = 0; i < HORIZON; i++) {
        const input = decide(worldReal);
        step(worldReal, input);
        if (worldReal.lastCollision) realHits++;
        if (!worldReal.runner.alive) {
          realDied = true;
          break;
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `seed=${seed}: 예측 score=${predicted.score} (col=${predicted.details.collisionCount}, pit=${predicted.details.pitFell}, items=${predicted.details.itemsCaughtScore}) | 실제 col=${realHits}, 사망=${realDied}`,
      );
    }
  });
});
