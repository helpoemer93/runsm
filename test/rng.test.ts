import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";

describe("Rng (시드 기반 난수)", () => {
  it("같은 시드는 같은 수열을 만든다", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it("다른 시드는 다른 수열을 만든다", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it("next()는 [0, 1) 범위 안에 있다", () => {
    const r = new Rng(123);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("nextInt(min, max)는 [min, max) 범위 안에 있다", () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.nextInt(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
    }
  });
});
