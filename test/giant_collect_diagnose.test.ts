// 거대화 상태 봇의 아이템 수집 여부 확인. 봇이 giant 활성 상태로 아이템 통과 시
// 실제로 잡히는지 여러 y 위치별 검증.

import { describe, it, expect } from "vitest";
import { createWorld, step, TICK_DURATION } from "../src/sim/world";
import { CharacterSpec, EquipmentSpec, Loadout, PetSpec } from "../src/sim/spec";
import { Stage, Item } from "../src/sim/stage";

import defaultChar from "../src/data/characters/hwangtae.json";
import destroyerPet from "../src/data/pets/nurungji.json";

const testStage: Stage = {
  id: "giant-test",
  length: 5000,
  obstacles: [],
  items: [],
  baseSpeed: 300,
};

const loadout: Loadout = {
  character: defaultChar as CharacterSpec,
  pet: destroyerPet as PetSpec,
  equipment: [] as EquipmentSpec[],
};

describe("거대화 아이템 수집 진단", () => {
  it("거대화 봇 몸통 안 다양한 y 위치 아이템 수집 검증", () => {
    // 여러 y 위치에 아이템 배치. 봇 지면 상태 baseHeight=50, 거대화 시 몸통 [0, 100].
    // 아이템 y가 [0, 100] 안이면 잡혀야 함. 밖이면 안 잡힘.
    const testItems: { y: number; expectCollected: boolean; label: string }[] =
      [
        { y: 0, expectCollected: true, label: "지면 (y=0)" },
        { y: 25, expectCollected: true, label: "지면 위쪽 (y=25)" },
        { y: 50, expectCollected: true, label: "기본 몸통 경계 (y=50)" },
        { y: 60, expectCollected: true, label: "거대화 몸통 안 (y=60)" },
        { y: 80, expectCollected: true, label: "거대화 몸통 안 (y=80)" },
        { y: 100, expectCollected: true, label: "거대화 몸통 상단 (y=100)" },
        { y: 120, expectCollected: false, label: "거대화 몸통 밖 (y=120)" },
      ];

    // 봇 x=300 도달 시점에 아이템 배치. 거대화 활성 상태 유지되도록 시작에 giant.
    const stageWithItems: Stage = {
      ...testStage,
      items: [
        // giant 아이템 (봇 시작 근처. 봇 첫 tick 잡기)
        { x: 105, y: 25, effect: "giant" as const },
        // 테스트 아이템들 (봇이 거대화 상태로 통과. baseSpeed 300 → 5초에 1500 이동)
        ...testItems.map((t, i) => ({
          x: 300 + i * 80, // 서로 안 겹치게 x 간격
          y: t.y,
          value: 1,
        })),
      ],
    };

    const w = createWorld(1, [stageWithItems], loadout);
    const testItemStartIdx = 1; // 첫 번째(giant) 이후

    // 초기 봇 x 위치 (SPAWN_X 등 상수). 로그로 확인.
    // 봇 몇 tick 시뮬 (봇 x=300 넘고 나서도 몇 tick)
    const maxTicks = 400;
    let tick = 0;
    let firstGiantTick = -1;
    while (w.runner.alive && tick < maxTicks) {
      step(w, { jump: false, slide: false });
      if (firstGiantTick < 0 && w.runner.giantTicks > 0) {
        firstGiantTick = tick;
      }
      tick++;
      // 봇 x가 마지막 테스트 아이템 통과했으면 종료
      if (w.runner.x > 300 + testItems.length * 80 + 100) break;
    }

    console.log(`\n봇 거대화 시작 tick=${firstGiantTick}, 종료 tick=${tick}`);
    console.log(
      `봇 최종 x=${w.runner.x.toFixed(0)}, y=${w.runner.y.toFixed(0)}, height=${w.runner.height.toFixed(0)}, giantTicks=${w.runner.giantTicks}`,
    );

    console.log("\n=== 아이템 수집 결과 ===");
    for (let i = 0; i < testItems.length; i++) {
      const idx = testItemStartIdx + i;
      const item = stageWithItems.items[idx]!;
      const collected = w.currentItemCollected[idx];
      const expected = testItems[i]!;
      const status = collected === expected.expectCollected ? "✓" : "✗ 문제!";
      console.log(
        `${status} ${expected.label} (x=${item.x}, y=${item.y}): 예상=${expected.expectCollected ? "잡힘" : "안잡힘"}, 실제=${collected ? "잡힘" : "안잡힘"}`,
      );
    }

    // 봇 giant 잡았는지도 확인
    const giantCollected = w.currentItemCollected[0];
    console.log(
      `\ngiant 아이템 잡았음: ${giantCollected}, 잡은 tick 근처 봇 giantTicks: ${firstGiantTick >= 0 ? "발동됨" : "발동안됨"}`,
    );

    expect(giantCollected).toBe(true);
  });
});
