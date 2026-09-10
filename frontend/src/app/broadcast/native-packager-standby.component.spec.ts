import "@angular/compiler";
import { Injector, runInInjectionContext, signal } from "@angular/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativePackagerStandbyComponent } from "./native-packager-standby.component";

const FIRST = "pkr_aaaaaaaaaaaaaaaa", SECOND = "pkr_bbbbbbbbbbbbbbbb";
function fixture() {
  const standby = { control: signal({ standbyRevision: 1, standbyPackagerIds: [FIRST] }),
    selected: signal<string[]>([FIRST, SECOND]), busy: signal(false), error: signal(""),
    setScope: vi.fn(), reset: vi.fn(), select: vi.fn(), load: vi.fn(async () => {}), save: vi.fn(async () => {}) };
  const component = runInInjectionContext(Injector.create({ providers: [] }), () => new NativePackagerStandbyComponent(standby as never));
  const inputs = { programId: signal("prg_aaaaaaaaaaaaaaaa"), programEpoch: signal(2), disabled: signal(false),
    candidates: signal([{ id: FIRST, label: "Laptop" }, { id: SECOND, label: "Mini-PC" }]) };
  Object.assign(component, inputs);
  return { component, standby, inputs };
}

describe("Standby selection local UI", () => {
  it("pins the source program output and never substitutes reset form defaults", async () => {
    const f = fixture(), policy = signal({ requestedRenditions: 2, allowHardwareAcceleration: false });
    Object.assign(f.component, { outputPolicy: policy });
    f.component.setRenditions("3"); expect(f.component.renditions()).toBe(1);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await f.component.save();
    expect(f.standby.save).toHaveBeenCalledExactlyOnceWith(2, "user-action", false);
  });
  it("rejects changed or invalid pinned output before a standby mutation", async () => {
    const f = fixture(), policy = signal({ requestedRenditions: 2, allowHardwareAcceleration: false });
    Object.assign(f.component, { outputPolicy: policy });
    vi.spyOn(window, "confirm").mockImplementation(() => { policy.set({ requestedRenditions: 2, allowHardwareAcceleration: true }); return true; });
    await f.component.save(); expect(f.standby.save).not.toHaveBeenCalled();
    for (const value of [{ requestedRenditions: 0, allowHardwareAcceleration: false }, { requestedRenditions: 4, allowHardwareAcceleration: false },
      { requestedRenditions: 1, allowHardwareAcceleration: "true" }]) {
      policy.set(value as never); expect(f.component.canSave()).toBe(false);
    }
  });
  afterEach(() => vi.restoreAllMocks());
  it("does not load on construction or input change and confirms saving explicitly", async () => {
    const f = fixture(); f.component.ngOnChanges();
    expect(f.standby.setScope).toHaveBeenCalledWith("prg_aaaaaaaaaaaaaaaa", 2);
    expect(f.standby.load).not.toHaveBeenCalled(); expect(f.standby.save).not.toHaveBeenCalled();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await f.component.save(); expect(f.standby.save).not.toHaveBeenCalled();
    confirm.mockReturnValue(true); await f.component.save();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("keine Medien oder Schlüssel"));
    expect(f.standby.save).toHaveBeenCalledExactlyOnceWith(1, "user-action");
  });
  for (const change of ["scope", "program", "selection", "candidate", "renditions", "busy"]) {
    it(`does not save an obsolete confirmation after ${change} changes`, async () => {
      const f = fixture();
      vi.spyOn(window, "confirm").mockImplementation(() => {
        if (change === "scope") f.inputs.disabled.set(true);
        if (change === "program") f.inputs.programId.set("prg_bbbbbbbbbbbbbbbb");
        if (change === "selection") f.standby.selected.set([SECOND]);
        if (change === "candidate") f.inputs.candidates.set([]);
        if (change === "renditions") f.component.renditions.set(3);
        if (change === "busy") f.standby.busy.set(true);
        return true;
      });
      await f.component.save(); expect(f.standby.save).not.toHaveBeenCalled();
    });
  }
  it("allows removal of unavailable former candidates but cannot add them or automatically take over", async () => {
    const f = fixture(); f.inputs.candidates.set([]);
    expect(f.component.options().every(option => !option.available)).toBe(true);
    f.component.toggle(FIRST, true); expect(f.standby.select).not.toHaveBeenCalled();
    f.component.toggle(FIRST, false); expect(f.standby.select).toHaveBeenCalledWith(FIRST, false);
    f.standby.selected.set([]); vi.spyOn(window, "confirm").mockReturnValue(true);
    await f.component.save(); expect(f.standby.save).toHaveBeenCalledOnce();
    expect(f.standby.load).not.toHaveBeenCalled();
  });
  it("clears scope on disabled/session changes and aborts on destroy", () => {
    const f = fixture(); f.inputs.disabled.set(true); f.component.ngOnChanges();
    expect(f.standby.setScope).toHaveBeenCalledWith("", 2);
    f.component.ngOnDestroy(); expect(f.standby.reset).toHaveBeenCalledOnce();
  });
});
