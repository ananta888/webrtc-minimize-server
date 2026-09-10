import { NativePackagerResourceBudget, NATIVE_PACKAGER_RESOURCE_ENV, NATIVE_PACKAGER_RESOURCE_DEFAULTS,
  normalizeNativePackagerResources } from "./native-packager-resource-budget.js";

const SCOPES = ["tenant", "principal"];
const fields = ["tenantId", "ownerPrincipal", "admission"];
const valid = value => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
  && /^tn_[A-Za-z0-9_-]{16,64}$/.test(value.tenantId || "")
  && typeof value.ownerPrincipal === "string" && value.ownerPrincipal.length >= 1 && value.ownerPrincipal.length <= 1024
  && !/[\u0000-\u001f\u007f]/.test(value.ownerPrincipal);

export function nativePackagerScopedResourcesFromEnvironment(env) {
  const result = {};
  for (const scope of SCOPES) {
    const limits = {};
    for (const [field, base] of Object.entries(NATIVE_PACKAGER_RESOURCE_ENV)) {
      const name = `${base}_PER_${scope.toUpperCase()}`;
      const raw = env[name] !== undefined ? env[name] : env[base] !== undefined ? env[base] : NATIVE_PACKAGER_RESOURCE_DEFAULTS[field];
      const value = Number(raw);
      if (!["string", "number"].includes(typeof raw) || typeof raw === "string" && !raw.trim()
        || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
        throw new TypeError(`invalid_${name}`);
      }
      limits[field] = value;
    }
    result[scope] = Object.freeze(limits);
  }
  return Object.freeze(result);
}

/** Policy only. Inventory and authenticated ownership belong to the registry. */
export class NativePackagerScopedResourceBudget {
  #global; #tenant; #principal;
  constructor(globalLimits, scopedLimits = {}) {
    if (!scopedLimits || typeof scopedLimits !== "object" || Array.isArray(scopedLimits)
      || Object.keys(scopedLimits).some(scope => !SCOPES.includes(scope))) throw new TypeError("invalid_native_packager_scoped_resources");
    const base = normalizeNativePackagerResources(globalLimits);
    for (const scope of SCOPES) {
      if (Object.hasOwn(scopedLimits, scope)) normalizeNativePackagerResources(scopedLimits[scope]);
    }
    this.#global = new NativePackagerResourceBudget(base);
    this.#tenant = new NativePackagerResourceBudget({ ...base, ...scopedLimits.tenant });
    this.#principal = new NativePackagerResourceBudget({ ...base, ...scopedLimits.principal });
  }
  snapshot(occupied) {
    if (!Array.isArray(occupied) || occupied.length > 20_000 || !occupied.every(valid)) {
      throw new TypeError("invalid_native_packager_resource_inventory");
    }
    return this.#global.snapshot(occupied.map(value => value.admission));
  }
  allows(candidate, occupied) {
    if (!valid(candidate) || !Array.isArray(occupied) || occupied.length > 20_000 || !occupied.every(valid)) return false;
    const tenant = occupied.filter(value => value.tenantId === candidate.tenantId);
    const principal = tenant.filter(value => value.ownerPrincipal === candidate.ownerPrincipal);
    return [[this.#global, occupied], [this.#tenant, tenant], [this.#principal, principal]]
      .every(([budget, inventory]) => budget.allows(candidate.admission, inventory.map(value => value.admission)));
  }
}
