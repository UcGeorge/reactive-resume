import { describe, expect, it } from "vitest";
import { hourlyRateSignal, payRangeWidthSignal } from "./index";

describe("payRangeWidthSignal", () => {
	it("flags a range wider than half its own floor (the $60k–$150k shape)", () => {
		const finding = payRangeWidthSignal({ lower: 60_000, upper: 150_000, currency: "USD", period: "annual" });
		expect(finding).not.toBeNull();
		expect(finding?.width).toBe(90_000);
		expect(finding?.note).toContain("not a legal threshold");
	});

	it("does not flag a normal range (the $90k–$110k shape)", () => {
		expect(payRangeWidthSignal({ lower: 90_000, upper: 110_000, currency: "USD", period: "annual" })).toBeNull();
	});

	it("skips a zero or negative floor instead of computing on it", () => {
		expect(payRangeWidthSignal({ lower: 0, upper: 100_000, currency: "USD", period: "annual" })).toBeNull();
		expect(payRangeWidthSignal({ lower: -1, upper: 100_000, currency: "USD", period: "annual" })).toBeNull();
	});

	it("skips an inverted or degenerate range", () => {
		expect(payRangeWidthSignal({ lower: 100_000, upper: 90_000, currency: "USD", period: "annual" })).toBeNull();
		expect(payRangeWidthSignal({ lower: 100_000, upper: 100_000, currency: "USD", period: "annual" })).toBeNull();
	});

	it("skips non-finite bounds", () => {
		expect(payRangeWidthSignal({ lower: Number.NaN, upper: 100_000, currency: "USD", period: "annual" })).toBeNull();
	});

	it("fires exactly at the boundary only when strictly greater", () => {
		// width == 0.5 × lower: not flagged (strictly greater required).
		expect(payRangeWidthSignal({ lower: 100_000, upper: 150_000, currency: "USD", period: "annual" })).toBeNull();
		expect(payRangeWidthSignal({ lower: 100_000, upper: 150_001, currency: "USD", period: "annual" })).not.toBeNull();
	});
});

describe("hourlyRateSignal", () => {
	it("passes an hourly amount through and says so", () => {
		const finding = hourlyRateSignal({ amount: 18, period: "hourly", currency: "USD" });
		expect(finding?.hourly).toBe(18);
		expect(finding?.hoursBasis).toBe("already-hourly");
	});

	it("converts annual pay with the 2080-hour fallback and discloses it", () => {
		const finding = hourlyRateSignal({ amount: 104_000, period: "annual", currency: "USD" });
		expect(finding?.hourly).toBe(50);
		expect(finding?.hoursBasis).toBe("2080-fallback");
		expect(finding?.note).toContain("2080");
	});

	it("prefers the JD's own stated hours and discloses that instead", () => {
		const finding = hourlyRateSignal({
			amount: 104_000,
			period: "annual",
			currency: "USD",
			statedHoursPerWeek: 50,
		});
		expect(finding?.hourly).toBe(40);
		expect(finding?.hoursBasis).toBe("jd-stated");
		expect(finding?.note).toContain("50 hours/week");
	});

	it("converts monthly to annual first", () => {
		const finding = hourlyRateSignal({ amount: 8666.666_666_666_666, period: "monthly", currency: "EUR" });
		expect(finding?.hourly).toBeCloseTo(50, 5);
	});

	it("skips non-positive amounts and unusable hours", () => {
		expect(hourlyRateSignal({ amount: 0, period: "annual", currency: "USD" })).toBeNull();
		expect(hourlyRateSignal({ amount: -5, period: "hourly", currency: "USD" })).toBeNull();
		expect(hourlyRateSignal({ amount: 104_000, period: "annual", currency: "USD", statedHoursPerWeek: 0 })).toBeNull();
	});

	it("never mentions a minimum-wage figure — routes the question out", () => {
		const finding = hourlyRateSignal({ amount: 104_000, period: "annual", currency: "USD" });
		expect(finding?.note).toContain("lawyer or an official source");
	});
});
