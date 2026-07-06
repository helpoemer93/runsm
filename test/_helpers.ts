import { CharacterSpec, Loadout } from "../src/sim/spec";
import { Stage } from "../src/sim/stage";
import { createWorld } from "../src/sim/world";
import defaultCharacterData from "../src/data/characters/default.json";

export const DEFAULT_CHARACTER: CharacterSpec = defaultCharacterData as CharacterSpec;

export const DEFAULT_LOADOUT: Loadout = {
  character: DEFAULT_CHARACTER,
  equipment: [],
};

// 단일 트랙으로 World를 만드는 테스트용 래퍼.
// 트랙이 끝까지 가면 같은 트랙이 다시 등장(반복) — 기존 단일 트랙 동작을 흉내냄.
export function createSingleTrackWorld(
  seed: number,
  stage: Stage,
  loadout: Loadout = DEFAULT_LOADOUT,
) {
  return createWorld(seed, [stage], loadout);
}
