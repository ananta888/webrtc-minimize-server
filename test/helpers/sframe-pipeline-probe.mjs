// Serialized only into the private test receiver's SFrame Worker. This probe
// counts existing transform calls; it adds no streams, retries, keys or frames.
export function installSFramePipelineProbe() {
  const rows = [], streams = new WeakMap(), reads = new WeakMap(), commands = new Map(), rowCommands = new WeakMap();
  let current = null, serial = 0;
  const increment = (row, field) => { if (row[field] < Number.MAX_SAFE_INTEGER) row[field]++; };
  const nativeListen = globalThis.addEventListener.bind(globalThis);
  const commandState = context => {
    if (typeof context !== "string" || !/^[A-Za-z0-9:_={}\-]{1,196}$/.test(context)) return null;
    let state = commands.get(context);
    if (!state) {
      state = { keySetCommands: 0, keyClearCommands: 0 }; commands.set(context, state);
      if (commands.size > 32) commands.delete(commands.keys().next().value);
    }
    return state;
  };
  nativeListen("message", ({ data }) => {
    if (data?.version !== 1) return;
    if (data.type === "clear-all") {
      for (const state of commands.values()) increment(state, "keyClearCommands");
    } else if (["set-key", "clear-context"].includes(data.type)) {
      const state = commandState(data.contextId);
      if (state) increment(state, data.type === "set-key" ? "keySetCommands" : "keyClearCommands");
    }
  });
  globalThis.addEventListener = (type, listener, ...options) => {
    if (type !== "rtctransform" || typeof listener !== "function") return nativeListen(type, listener, ...options);
    return nativeListen(type, function(event) {
      const direction = event.transformer?.options?.direction;
      const row = { index: ++serial, direction: ["encrypt", "decrypt"].includes(direction) ? direction : "unknown",
        inputKey: 0, inputDelta: 0, inputOther: 0, enqueuedKey: 0, enqueuedDelta: 0, enqueuedOther: 0,
        dropped: 0, thrown: 0, ended: false, pipeFailed: false };
      rows.push(row); if (rows.length > 16) rows.shift();
      rowCommands.set(row, commandState(event.transformer?.options?.contextId));
      const previous = current; current = row;
      try { return listener.call(this, event); } finally { current = previous; }
    }, ...options);
  };
  const NativeTransform = globalThis.TransformStream;
  globalThis.TransformStream = new Proxy(NativeTransform, { construct(Target, args) {
    const row = current, transformer = args[0];
    if (!row || typeof transformer?.transform !== "function") return Reflect.construct(Target, args);
    const original = transformer.transform;
    const observed = { ...transformer, async transform(frame, controller) {
      const kind = frame.type === "key" ? "Key" : frame.type === "delta" ? "Delta" : "Other";
      increment(row, "input" + kind); let enqueued = false;
      const output = new Proxy(controller, { get(target, property) {
        if (property === "enqueue") return value => {
          target.enqueue(value); enqueued = true; increment(row, "enqueued" + kind);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      try { return await original.call(this, frame, output); }
      catch (error) { increment(row, "thrown"); throw error; }
      finally { if (!enqueued) increment(row, "dropped"); }
    } };
    const stream = Reflect.construct(Target, [observed, ...args.slice(1)]);
    streams.set(stream, row); return stream;
  } });
  const nativeThrough = ReadableStream.prototype.pipeThrough, nativeTo = ReadableStream.prototype.pipeTo;
  ReadableStream.prototype.pipeThrough = function(transform, ...options) {
    const result = nativeThrough.call(this, transform, ...options);
    const row = streams.get(transform); if (row) reads.set(result, row);
    return result;
  };
  ReadableStream.prototype.pipeTo = function(...args) {
    const result = nativeTo.apply(this, args), row = reads.get(this);
    if (row) void result.then(() => { row.ended = true; }, () => { row.ended = true; row.pipeFailed = true; });
    return result;
  };
  globalThis.__testSFramePipelineReport = () => ({ schema: "meet.test-sframe-pipeline.v1",
    available: true, total: serial, truncated: serial > 16, rows: rows.map(row => ({ ...row,
      keySetCommands: rowCommands.get(row)?.keySetCommands ?? 0,
      keyClearCommands: rowCommands.get(row)?.keyClearCommands ?? 0 })) });
}

export async function installPrivateSFramePipelineRoute(context) {
  await context.route(/\/worker-[A-Za-z0-9_-]+\.js(?:\?.*)?$/, async route => {
    const response = await route.fetch({ timeout: 5000 }), body = await response.text();
    if (body.length > 512 * 1024) throw new Error("test_sframe_probe_asset_budget");
    const sframe = body.includes('"rtctransform"') && body.includes("media_envelope_version");
    await route.fulfill({ response, body: sframe ? `(${installSFramePipelineProbe.toString()})();\n${body}` : body });
  });
}

export async function collectSFramePipelines(page) {
  let timer;
  try {
    return await Promise.race([
      Promise.all(page.workers().slice(0, 4).map(worker => worker.evaluate(() => {
        if (typeof globalThis.__testSFramePipelineReport !== "function") return null;
        const value = globalThis.__testSFramePipelineReport();
        return { ...value, rows: value.rows.slice(-4), truncated: value.total > 4 };
      }))).then(rows => {
        const workers = rows.filter(Boolean), value = { available: workers.length > 0, workers };
        return JSON.stringify(value).length <= 6000 ? value : { available: false, workers: [] };
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("test_sframe_probe_timeout")), 1000); }),
    ]);
  } catch { return { available: false, workers: [] }; }
  finally { clearTimeout(timer); }
}
