import { CharacterSpec, EquipmentSpec, PetSpec } from "../sim/spec";

// 보유 장비 인스턴스. specId는 EquipmentSpec.id와 매칭.
// level은 강화 레벨(0 = 미강화).
export interface ItemInstance {
  id: number;
  specId: string;
  level: number;
}

export interface InventoryState {
  nextItemId: number;
  maxBagSize: number;
  bagItems: ItemInstance[]; // 장착되지 않은 보관 아이템
  botEquipped: (ItemInstance | null)[][]; // [botIdx][slotIdx]
  botCharacterId: string[]; // [botIdx] — 캐릭터 spec id
  botPetId: (string | null)[]; // [botIdx] — 펫 spec id, null이면 펫 없음
}

// 봇별 기본 캐릭터/펫 (첫 실행 시) — 사용자가 즉시 변경 가능.
// 데이터 파일이 없어지면 fallback 처리.
const DEFAULT_BOT_CHARACTER_IDS = ["hwangtae", "meru"];
const DEFAULT_BOT_PET_IDS = ["geumbungeo", "nurungji"];

export const SLOT_COUNT = 3;
export const INITIAL_BAG_SIZE = 20;
export const GACHA_COST = 100;
export const BAG_EXPAND_STEP = 5; // 한 번에 늘어나는 칸 수
export function bagExpandCost(currentSize: number): number {
  // 현재 크기 × 50코인 — 가방이 커질수록 비싸짐.
  return currentSize * 50;
}

// 강화 비용: (현재 lv + 1)^2 × 10. lv0→1: 10, lv10→11: 1210, lv20→21: 4410, lv50→51: 26010.
export function enhanceCost(currentLevel: number): number {
  const next = currentLevel + 1;
  return next * next * 10;
}

// 인스턴스 base spec + 강화 레벨로 시뮬에 줄 effective spec 생성.
// 한 인스턴스가 시뮬에 들어갈 때마다 호출 — 새 객체라 base spec 안 건드림.
export function effectiveSpec(inst: ItemInstance): EquipmentSpec | undefined {
  const base = equipmentBySpecId[inst.specId];
  if (!base) return undefined;
  if (inst.level <= 0 || !base.enhanceDelta) return base;
  const d = base.enhanceDelta;
  const eff: EquipmentSpec = { id: base.id, name: base.name };
  if (base.runSpeedMult !== undefined || d.runSpeedMult)
    eff.runSpeedMult = (base.runSpeedMult ?? 1) + (d.runSpeedMult ?? 0) * inst.level;
  if (base.jumpVelocityMult !== undefined || d.jumpVelocityMult)
    eff.jumpVelocityMult =
      (base.jumpVelocityMult ?? 1) + (d.jumpVelocityMult ?? 0) * inst.level;
  if (base.healDashSeconds !== undefined || d.healDashSeconds)
    eff.healDashSeconds =
      (base.healDashSeconds ?? 0) + (d.healDashSeconds ?? 0) * inst.level;
  if (base.coinValueMult !== undefined || d.coinValueMult)
    eff.coinValueMult =
      (base.coinValueMult ?? 1) + (d.coinValueMult ?? 0) * inst.level;
  return eff;
}

const STORAGE_KEY = "runsm.inventory.v1";

// 모든 장비 자료를 import.meta.glob으로 자동 수집 → specId로 조회.
const equipmentModules = import.meta.glob<{ default: EquipmentSpec }>(
  "../data/equipment/*.json",
  { eager: true },
);
const equipmentBySpecId: Record<string, EquipmentSpec> = {};
for (const m of Object.values(equipmentModules)) {
  equipmentBySpecId[m.default.id] = m.default;
}

// 캐릭터·펫도 동일 패턴으로 자동 수집 — 새 JSON 추가 시 코드 수정 불필요.
const characterModules = import.meta.glob<{ default: CharacterSpec }>(
  "../data/characters/*.json",
  { eager: true },
);
const characterBySpecId: Record<string, CharacterSpec> = {};
for (const m of Object.values(characterModules)) {
  characterBySpecId[m.default.id] = m.default;
}

const petModules = import.meta.glob<{ default: PetSpec }>(
  "../data/pets/*.json",
  { eager: true },
);
const petBySpecId: Record<string, PetSpec> = {};
for (const m of Object.values(petModules)) {
  petBySpecId[m.default.id] = m.default;
}

export function lookupSpec(specId: string): EquipmentSpec | undefined {
  return equipmentBySpecId[specId];
}

export function allEquipmentSpecs(): EquipmentSpec[] {
  return Object.values(equipmentBySpecId);
}

export function lookupCharacter(id: string): CharacterSpec | undefined {
  return characterBySpecId[id];
}

export function allCharacters(): CharacterSpec[] {
  return Object.values(characterBySpecId);
}

export function lookupPet(id: string): PetSpec | undefined {
  return petBySpecId[id];
}

export function allPets(): PetSpec[] {
  return Object.values(petBySpecId);
}

// 사용 가능한 캐릭터 풀에서 안전한 기본 캐릭터 id 결정.
// DEFAULT_BOT_CHARACTER_IDS의 매핑이 없으면 풀의 첫 캐릭터로 fallback.
function pickDefaultCharacterId(botIdx: number): string {
  const desired = DEFAULT_BOT_CHARACTER_IDS[botIdx];
  if (desired && characterBySpecId[desired]) return desired;
  const all = allCharacters();
  return all[0]?.id ?? "";
}

// 펫은 null 가능. 매핑이 풀에 없으면 null로 fallback.
function pickDefaultPetId(botIdx: number): string | null {
  const desired = DEFAULT_BOT_PET_IDS[botIdx];
  if (desired && petBySpecId[desired]) return desired;
  return null;
}

function makeInitialState(botCount: number): InventoryState {
  const state: InventoryState = {
    nextItemId: 1,
    maxBagSize: INITIAL_BAG_SIZE,
    bagItems: [],
    botEquipped: [],
    botCharacterId: [],
    botPetId: [],
  };
  const specs = allEquipmentSpecs();
  for (let b = 0; b < botCount; b++) {
    const slots: (ItemInstance | null)[] = [];
    for (let s = 0; s < SLOT_COUNT; s++) {
      const spec = specs[s] ?? null;
      if (spec) {
        slots.push({ id: state.nextItemId++, specId: spec.id, level: 0 });
      } else {
        slots.push(null);
      }
    }
    state.botEquipped.push(slots);
    state.botCharacterId.push(pickDefaultCharacterId(b));
    state.botPetId.push(pickDefaultPetId(b));
  }
  return state;
}

// 저장된 값이 깨졌거나 봇 수가 바뀐 경우의 안전장치.
// 인스턴스 형태가 깨지면 그 슬롯/아이템은 버리고, 알 수 없는 specId도 버린다.
function sanitize(raw: unknown, botCount: number): InventoryState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const nextItemId = Number(obj.nextItemId);
  const maxBagSize = Number(obj.maxBagSize);
  if (!Number.isFinite(nextItemId) || nextItemId < 1) return null;
  if (!Number.isFinite(maxBagSize) || maxBagSize < SLOT_COUNT) return null;
  if (!Array.isArray(obj.bagItems) || !Array.isArray(obj.botEquipped))
    return null;

  const sanitizeInstance = (v: unknown): ItemInstance | null => {
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    const id = Number(o.id);
    const specId = String(o.specId ?? "");
    if (!Number.isFinite(id) || id < 1) return null;
    if (!equipmentBySpecId[specId]) return null;
    const levelRaw = Number(o.level);
    const level =
      Number.isFinite(levelRaw) && levelRaw >= 0 ? Math.floor(levelRaw) : 0;
    return { id, specId, level };
  };

  const bagItems: ItemInstance[] = [];
  for (const v of obj.bagItems) {
    const inst = sanitizeInstance(v);
    if (inst) bagItems.push(inst);
  }

  const botEquipped: (ItemInstance | null)[][] = [];
  for (let b = 0; b < botCount; b++) {
    const stored = (obj.botEquipped as unknown[])[b];
    const slots: (ItemInstance | null)[] = [];
    if (Array.isArray(stored)) {
      for (let s = 0; s < SLOT_COUNT; s++) {
        slots.push(sanitizeInstance(stored[s]));
      }
    } else {
      for (let s = 0; s < SLOT_COUNT; s++) slots.push(null);
    }
    botEquipped.push(slots);
  }

  // 캐릭터/펫 id 복원 — 풀에 없는 id는 기본값으로 fallback (데이터 파일 삭제·rename 대응).
  const storedCharIds = Array.isArray(obj.botCharacterId)
    ? (obj.botCharacterId as unknown[])
    : [];
  const storedPetIds = Array.isArray(obj.botPetId)
    ? (obj.botPetId as unknown[])
    : [];
  const botCharacterId: string[] = [];
  const botPetId: (string | null)[] = [];
  for (let b = 0; b < botCount; b++) {
    const rawChar = storedCharIds[b];
    const charId =
      typeof rawChar === "string" && characterBySpecId[rawChar]
        ? rawChar
        : pickDefaultCharacterId(b);
    botCharacterId.push(charId);

    const rawPet = storedPetIds[b];
    let petId: string | null;
    if (rawPet === null) {
      petId = null;
    } else if (typeof rawPet === "string" && petBySpecId[rawPet]) {
      petId = rawPet;
    } else {
      petId = pickDefaultPetId(b);
    }
    botPetId.push(petId);
  }

  return {
    nextItemId: Math.floor(nextItemId),
    maxBagSize: Math.floor(maxBagSize),
    bagItems,
    botEquipped,
    botCharacterId,
    botPetId,
  };
}

export function loadInventory(botCount: number): InventoryState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      const sanitized = sanitize(parsed, botCount);
      if (sanitized) return sanitized;
    } catch {
      // 파싱 실패 시 초기 상태로 떨어짐
    }
  }
  return makeInitialState(botCount);
}

export function saveInventory(state: InventoryState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// 봇의 장착 슬롯을 시뮬용 EquipmentSpec[]로 변환 — 강화 레벨 반영된 effective spec.
export function equippedSpecs(
  state: InventoryState,
  botIdx: number,
): EquipmentSpec[] {
  const slots = state.botEquipped[botIdx] ?? [];
  const result: EquipmentSpec[] = [];
  for (const inst of slots) {
    if (!inst) continue;
    const eff = effectiveSpec(inst);
    if (eff) result.push(eff);
  }
  return result;
}

// 인스턴스 강화 — 비용 검증·차감은 호출자 책임. level만 +1.
export function enhanceInstance(inst: ItemInstance) {
  inst.level++;
}

// 가방에 한 칸 비었는지 (해제 가능 여부 판단용)
export function hasBagSpace(state: InventoryState): boolean {
  return state.bagItems.length < state.maxBagSize;
}

// 봇의 첫 번째 빈 슬롯 인덱스 (없으면 -1)
export function firstEmptySlot(
  state: InventoryState,
  botIdx: number,
): number {
  const slots = state.botEquipped[botIdx] ?? [];
  for (let i = 0; i < slots.length; i++) if (slots[i] === null) return i;
  return -1;
}

// 가방에서 itemId 찾아 첫 빈 슬롯에 장착. 성공하면 true.
export function equipFromBag(
  state: InventoryState,
  botIdx: number,
  itemId: number,
): boolean {
  const slotIdx = firstEmptySlot(state, botIdx);
  if (slotIdx < 0) return false;
  const bagIdx = state.bagItems.findIndex((it) => it.id === itemId);
  if (bagIdx < 0) return false;
  const [item] = state.bagItems.splice(bagIdx, 1);
  state.botEquipped[botIdx]![slotIdx] = item!;
  return true;
}

// 봇 슬롯 비우고 가방으로 옮김. 가방 가득이면 false.
export function unequipToBag(
  state: InventoryState,
  botIdx: number,
  slotIdx: number,
): boolean {
  const item = state.botEquipped[botIdx]?.[slotIdx];
  if (!item) return false;
  if (!hasBagSpace(state)) return false;
  state.botEquipped[botIdx]![slotIdx] = null;
  state.bagItems.push(item);
  return true;
}

// 가방에서 itemId를 제거. 성공 시 true.
export function removeBagItem(state: InventoryState, itemId: number): boolean {
  const idx = state.bagItems.findIndex((it) => it.id === itemId);
  if (idx < 0) return false;
  state.bagItems.splice(idx, 1);
  return true;
}

// 가방 가득이 아닌 상태에서 풀에서 균등하게 한 개 뽑아 가방에 추가. 가득이면 null 반환.
// 시뮬과 무관한 사용자 인터랙션이라 시드 결정론 적용 안 함.
export function gachaDraw(state: InventoryState): ItemInstance | null {
  if (!hasBagSpace(state)) return null;
  const specs = allEquipmentSpecs();
  if (specs.length === 0) return null;
  const spec = specs[Math.floor(Math.random() * specs.length)]!;
  const instance: ItemInstance = {
    id: state.nextItemId++,
    specId: spec.id,
    level: 0,
  };
  state.bagItems.push(instance);
  return instance;
}

// 가방 칸 BAG_EXPAND_STEP만큼 늘림. 호출자가 코인 차감·검증 책임짐.
export function expandBag(state: InventoryState) {
  state.maxBagSize += BAG_EXPAND_STEP;
}

// 봇의 캐릭터 변경. id가 풀에 있어야 적용됨.
export function setBotCharacter(
  state: InventoryState,
  botIdx: number,
  characterId: string,
): boolean {
  if (!characterBySpecId[characterId]) return false;
  if (botIdx < 0 || botIdx >= state.botCharacterId.length) return false;
  state.botCharacterId[botIdx] = characterId;
  return true;
}

// 봇의 펫 변경. id가 null이면 펫 없음. 풀에 없는 id는 거부.
export function setBotPet(
  state: InventoryState,
  botIdx: number,
  petId: string | null,
): boolean {
  if (petId !== null && !petBySpecId[petId]) return false;
  if (botIdx < 0 || botIdx >= state.botPetId.length) return false;
  state.botPetId[botIdx] = petId;
  return true;
}

// 봇이 현재 장착한 캐릭터 spec — 없으면 풀 첫 캐릭터 fallback (UI 표시용).
export function botCharacter(
  state: InventoryState,
  botIdx: number,
): CharacterSpec | undefined {
  const id = state.botCharacterId[botIdx];
  if (id && characterBySpecId[id]) return characterBySpecId[id];
  return allCharacters()[0];
}

// 봇이 현재 장착한 펫 spec — 없으면 undefined.
export function botPet(
  state: InventoryState,
  botIdx: number,
): PetSpec | undefined {
  const id = state.botPetId[botIdx];
  if (id && petBySpecId[id]) return petBySpecId[id];
  return undefined;
}
