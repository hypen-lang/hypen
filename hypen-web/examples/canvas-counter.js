// ../hypen-engine-rs/pkg/browser/hypen_engine.js
var wasm;
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
var MAX_SAFARI_DECODE_BYTES = 2146435072;
var numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}
function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_export_2.set(idx, obj);
  return idx;
}
function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    const idx = addToExternrefTable0(e);
    wasm.__wbindgen_exn_store(idx);
  }
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
function isLikeNone(x) {
  return x === undefined || x === null;
}
var cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}
function debugString(val) {
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1;i < length; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    return toString.call(val);
  }
  if (className == "Object") {
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}
${val.stack}`;
  }
  return className;
}
var WASM_VECTOR_LEN = 0;
var cachedTextEncoder = new TextEncoder;
if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function(arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length
    };
  };
}
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (;offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127)
      break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_export_2.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
function passArrayJsValueToWasm0(array, malloc) {
  const ptr = malloc(array.length * 4, 4) >>> 0;
  for (let i = 0;i < array.length; i++) {
    const add = addToExternrefTable0(array[i]);
    getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
  }
  WASM_VECTOR_LEN = array.length;
  return ptr;
}
var WasmEngineFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {}, unregister: () => {} } : new FinalizationRegistry((ptr) => wasm.__wbg_wasmengine_free(ptr >>> 0, 1));

class WasmEngine {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    WasmEngineFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_wasmengine_free(ptr, 0);
  }
  constructor() {
    const ret = wasm.wasmengine_new();
    this.__wbg_ptr = ret >>> 0;
    WasmEngineFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  renderSource(source) {
    const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_renderSource(this.__wbg_ptr, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  setRenderCallback(callback) {
    wasm.wasmengine_setRenderCallback(this.__wbg_ptr, callback);
  }
  setComponentResolver(resolver) {
    wasm.wasmengine_setComponentResolver(this.__wbg_ptr, resolver);
  }
  registerPrimitive(name) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.wasmengine_registerPrimitive(this.__wbg_ptr, ptr0, len0);
  }
  renderLazyComponent(source) {
    const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_renderLazyComponent(this.__wbg_ptr, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  renderInto(source, parent_node_id_str, state_js) {
    const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(parent_node_id_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_renderInto(this.__wbg_ptr, ptr0, len0, ptr1, len1, state_js);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  updateState(state_patch) {
    const ret = wasm.wasmengine_updateState(this.__wbg_ptr, state_patch);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  dispatchAction(name, payload) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_dispatchAction(this.__wbg_ptr, ptr0, len0, payload);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  onAction(action_name, handler) {
    const ptr0 = passStringToWasm0(action_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.wasmengine_onAction(this.__wbg_ptr, ptr0, len0, handler);
  }
  clearTree() {
    wasm.wasmengine_clearTree(this.__wbg_ptr);
  }
  debugParseComponent(source) {
    let deferred3_0;
    let deferred3_1;
    try {
      const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ret = wasm.wasmengine_debugParseComponent(this.__wbg_ptr, ptr0, len0);
      var ptr2 = ret[0];
      var len2 = ret[1];
      if (ret[3]) {
        ptr2 = 0;
        len2 = 0;
        throw takeFromExternrefTable0(ret[2]);
      }
      deferred3_0 = ptr2;
      deferred3_1 = len2;
      return getStringFromWasm0(ptr2, len2);
    } finally {
      wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
  }
  setModule(name, actions, state_keys, initial_state) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayJsValueToWasm0(actions, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayJsValueToWasm0(state_keys, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_setModule(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, initial_state);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  getRevision() {
    const ret = wasm.wasmengine_getRevision(this.__wbg_ptr);
    return BigInt.asUintN(64, ret);
  }
}
if (Symbol.dispose)
  WasmEngine.prototype[Symbol.dispose] = WasmEngine.prototype.free;
var EXPECTED_RESPONSE_TYPES = new Set(["basic", "cors", "default"]);
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);
        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
}
function __wbg_get_imports() {
  const imports = {};
  imports.wbg = {};
  imports.wbg.__wbg_Error_e17e777aac105295 = function(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbg_call_13410aac570ffff7 = function() {
    return handleError(function(arg0, arg1) {
      const ret = arg0.call(arg1);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_call_641db1bb5db5a579 = function() {
    return handleError(function(arg0, arg1, arg2, arg3) {
      const ret = arg0.call(arg1, arg2, arg3);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_call_a5400b25a865cfd8 = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = arg0.call(arg1, arg2);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_done_75ed0ee6dd243d9d = function(arg0) {
    const ret = arg0.done;
    return ret;
  };
  imports.wbg.__wbg_entries_2be2f15bd5554996 = function(arg0) {
    const ret = Object.entries(arg0);
    return ret;
  };
  imports.wbg.__wbg_error_99981e16d476aa5c = function(arg0) {
    console.error(arg0);
  };
  imports.wbg.__wbg_get_0da715ceaecea5c8 = function(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return ret;
  };
  imports.wbg.__wbg_get_458e874b43b18b25 = function() {
    return handleError(function(arg0, arg1) {
      const ret = Reflect.get(arg0, arg1);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_instanceof_ArrayBuffer_67f3012529f6a2dd = function(arg0) {
    let result;
    try {
      result = arg0 instanceof ArrayBuffer;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Map_ebb01a5b6b5ffd0b = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Map;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Uint8Array_9a8378d955933db7 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Uint8Array;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_isArray_030cce220591fb41 = function(arg0) {
    const ret = Array.isArray(arg0);
    return ret;
  };
  imports.wbg.__wbg_isSafeInteger_1c0d1af5542e102a = function(arg0) {
    const ret = Number.isSafeInteger(arg0);
    return ret;
  };
  imports.wbg.__wbg_iterator_f370b34483c71a1c = function() {
    const ret = Symbol.iterator;
    return ret;
  };
  imports.wbg.__wbg_length_186546c51cd61acd = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_length_6bb7e81f9d7713e4 = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_log_6c7b5f4f00b8ce3f = function(arg0) {
    console.log(arg0);
  };
  imports.wbg.__wbg_new_19c25a3f2fa63a02 = function() {
    const ret = new Object;
    return ret;
  };
  imports.wbg.__wbg_new_1f3a344cf3123716 = function() {
    const ret = new Array;
    return ret;
  };
  imports.wbg.__wbg_new_2ff1f68f3676ea53 = function() {
    const ret = new Map;
    return ret;
  };
  imports.wbg.__wbg_new_638ebfaedbf32a5e = function(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
  };
  imports.wbg.__wbg_next_5b3530e612fde77d = function(arg0) {
    const ret = arg0.next;
    return ret;
  };
  imports.wbg.__wbg_next_692e82279131b03c = function() {
    return handleError(function(arg0) {
      const ret = arg0.next();
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_prototypesetcall_3d4a26c1ed734349 = function(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
  };
  imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
  };
  imports.wbg.__wbg_set_90f6c0f7bd8c0415 = function(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
  };
  imports.wbg.__wbg_set_b7f1cf4fae26fe2a = function(arg0, arg1, arg2) {
    const ret = arg0.set(arg1, arg2);
    return ret;
  };
  imports.wbg.__wbg_value_dd9372230531eade = function(arg0) {
    const ret = arg0.value;
    return ret;
  };
  imports.wbg.__wbg_wbindgenbigintgetasi64_ac743ece6ab9bba1 = function(arg0, arg1) {
    const v = arg1;
    const ret = typeof v === "bigint" ? v : undefined;
    getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
  };
  imports.wbg.__wbg_wbindgenbooleanget_3fe6f642c7d97746 = function(arg0) {
    const v = arg0;
    const ret = typeof v === "boolean" ? v : undefined;
    return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
  };
  imports.wbg.__wbg_wbindgendebugstring_99ef257a3ddda34d = function(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg_wbindgenin_d7a1ee10933d2d55 = function(arg0, arg1) {
    const ret = arg0 in arg1;
    return ret;
  };
  imports.wbg.__wbg_wbindgenisbigint_ecb90cc08a5a9154 = function(arg0) {
    const ret = typeof arg0 === "bigint";
    return ret;
  };
  imports.wbg.__wbg_wbindgenisfunction_8cee7dce3725ae74 = function(arg0) {
    const ret = typeof arg0 === "function";
    return ret;
  };
  imports.wbg.__wbg_wbindgenisnull_f3037694abe4d97a = function(arg0) {
    const ret = arg0 === null;
    return ret;
  };
  imports.wbg.__wbg_wbindgenisobject_307a53c6bd97fbf8 = function(arg0) {
    const val = arg0;
    const ret = typeof val === "object" && val !== null;
    return ret;
  };
  imports.wbg.__wbg_wbindgenisstring_d4fa939789f003b0 = function(arg0) {
    const ret = typeof arg0 === "string";
    return ret;
  };
  imports.wbg.__wbg_wbindgenisundefined_c4b71d073b92f3c5 = function(arg0) {
    const ret = arg0 === undefined;
    return ret;
  };
  imports.wbg.__wbg_wbindgenjsvaleq_e6f2ad59ccae1b58 = function(arg0, arg1) {
    const ret = arg0 === arg1;
    return ret;
  };
  imports.wbg.__wbg_wbindgenjsvallooseeq_9bec8c9be826bed1 = function(arg0, arg1) {
    const ret = arg0 == arg1;
    return ret;
  };
  imports.wbg.__wbg_wbindgennumberget_f74b4c7525ac05cb = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof obj === "number" ? obj : undefined;
    getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
  };
  imports.wbg.__wbg_wbindgenstringget_0f16a6ddddef376f = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof obj === "string" ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg_wbindgenthrow_451ec1a8469d7eb6 = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
  };
  imports.wbg.__wbindgen_cast_4625c577ab2ec9ee = function(arg0) {
    const ret = BigInt.asUintN(64, arg0);
    return ret;
  };
  imports.wbg.__wbindgen_cast_9ae0607507abb057 = function(arg0) {
    const ret = arg0;
    return ret;
  };
  imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
    const ret = arg0;
    return ret;
  };
  imports.wbg.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_export_2;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
  };
  return imports;
}
function __wbg_init_memory(imports, memory) {}
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  __wbg_init.__wbindgen_wasm_module = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
async function __wbg_init(module_or_path) {
  if (wasm !== undefined)
    return wasm;
  if (typeof module_or_path !== "undefined") {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  if (typeof module_or_path === "undefined") {
    module_or_path = new URL("hypen_engine_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  __wbg_init_memory(imports);
  const { instance, module } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance, module);
}
var hypen_engine_default = __wbg_init;

// src/engine.browser.ts
function mapToObject(value) {
  if (value instanceof Map) {
    const obj = {};
    for (const [key, val] of value.entries()) {
      obj[key] = mapToObject(val);
    }
    return obj;
  } else if (Array.isArray(value)) {
    return value.map(mapToObject);
  } else if (value && typeof value === "object" && value.constructor === Object) {
    const obj = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = mapToObject(val);
    }
    return obj;
  }
  return value;
}

class Engine {
  wasmEngine = null;
  initialized = false;
  async init() {
    if (this.initialized)
      return;
    await hypen_engine_default("/hypen_engine_bg.wasm");
    this.wasmEngine = new WasmEngine;
    this.initialized = true;
  }
  ensureInitialized() {
    if (!this.wasmEngine) {
      throw new Error("Engine not initialized. Call init() first.");
    }
    return this.wasmEngine;
  }
  setRenderCallback(callback) {
    const engine = this.ensureInitialized();
    engine.setRenderCallback((patches) => {
      callback(patches);
    });
  }
  setComponentResolver(resolver) {
    const engine = this.ensureInitialized();
    engine.setComponentResolver((componentName, contextPath) => {
      const result = resolver(componentName, contextPath);
      return result;
    });
  }
  renderSource(source) {
    const engine = this.ensureInitialized();
    engine.renderSource(source);
  }
  renderLazyComponent(source) {
    const engine = this.ensureInitialized();
    engine.renderLazyComponent(source);
  }
  renderInto(source, parentNodeId, state) {
    const engine = this.ensureInitialized();
    const safeState = JSON.parse(JSON.stringify(state));
    engine.renderInto(source, parentNodeId, safeState);
  }
  notifyStateChange(paths, currentState) {
    const engine = this.ensureInitialized();
    const plainObject = JSON.parse(JSON.stringify(currentState));
    engine.updateState(plainObject);
    if (paths.length > 0) {
      console.debug("[Hypen] State changed:", paths);
    }
  }
  updateState(statePatch) {
    const engine = this.ensureInitialized();
    const plainObject = JSON.parse(JSON.stringify(statePatch));
    engine.updateState(plainObject);
  }
  dispatchAction(name, payload) {
    const engine = this.ensureInitialized();
    console.log(`\uD83D\uDD04 [Engine] Action dispatched: ${name}`);
    engine.dispatchAction(name, payload ?? null);
  }
  onAction(actionName, handler) {
    const engine = this.ensureInitialized();
    engine.onAction(actionName, (action) => {
      const normalizedAction = {
        ...action,
        payload: action.payload ? mapToObject(action.payload) : action.payload
      };
      Promise.resolve(handler(normalizedAction)).catch(console.error);
    });
  }
  setModule(name, actions, stateKeys, initialState) {
    const engine = this.ensureInitialized();
    engine.setModule(name, actions, stateKeys, initialState);
  }
  getRevision() {
    const engine = this.ensureInitialized();
    return engine.getRevision();
  }
  clearTree() {
    const engine = this.ensureInitialized();
    engine.clearTree();
  }
  debugParseComponent(source) {
    const engine = this.ensureInitialized();
    return engine.debugParseComponent(source);
  }
}

// src/state.ts
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
function diffState(oldState, newState, basePath = "") {
  const paths = [];
  const newValues = {};
  function diff(oldVal, newVal, path) {
    if (oldVal === newVal)
      return;
    if (typeof oldVal !== "object" || typeof newVal !== "object" || oldVal === null || newVal === null) {
      if (oldVal !== newVal) {
        paths.push(path);
        newValues[path] = newVal;
      }
      return;
    }
    if (Array.isArray(oldVal) || Array.isArray(newVal)) {
      if (!Array.isArray(oldVal) || !Array.isArray(newVal) || oldVal.length !== newVal.length) {
        paths.push(path);
        newValues[path] = newVal;
        return;
      }
      for (let i = 0;i < newVal.length; i++) {
        const itemPath = path ? `${path}.${i}` : `${i}`;
        diff(oldVal[i], newVal[i], itemPath);
      }
      return;
    }
    const oldKeys = new Set(Object.keys(oldVal));
    const newKeys = new Set(Object.keys(newVal));
    for (const key of newKeys) {
      const propPath = path ? `${path}.${key}` : key;
      if (!oldKeys.has(key)) {
        paths.push(propPath);
        newValues[propPath] = newVal[key];
      } else {
        diff(oldVal[key], newVal[key], propPath);
      }
    }
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        const propPath = path ? `${path}.${key}` : key;
        paths.push(propPath);
        newValues[propPath] = undefined;
      }
    }
  }
  diff(oldState, newState, basePath);
  return { paths, newValues };
}
function createObservableState(initialState, options) {
  let lastSnapshot = deepClone(initialState);
  const pathPrefix = options.pathPrefix || "";
  let batchDepth = 0;
  let pendingChange = null;
  function notifyChange() {
    if (batchDepth > 0)
      return;
    const change = diffState(lastSnapshot, state, pathPrefix);
    if (change.paths.length > 0) {
      lastSnapshot = deepClone(state);
      if (pendingChange) {
        change.paths.push(...pendingChange.paths);
        Object.assign(change.newValues, pendingChange.newValues);
        pendingChange = null;
      }
      options.onChange(change);
    }
  }
  function scheduleBatch() {
    if (batchDepth === 0) {
      queueMicrotask(() => {
        if (batchDepth === 0) {
          notifyChange();
        }
      });
    }
  }
  function createProxy(target, basePath) {
    return new Proxy(target, {
      get(obj, prop) {
        const value = obj[prop];
        if (prop === "__beginBatch") {
          return () => {
            batchDepth++;
          };
        }
        if (prop === "__endBatch") {
          return () => {
            batchDepth--;
            if (batchDepth === 0) {
              notifyChange();
            }
          };
        }
        if (prop === "__getSnapshot") {
          return () => deepClone(obj);
        }
        if (value && typeof value === "object") {
          return createProxy(value, basePath ? `${basePath}.${String(prop)}` : String(prop));
        }
        return value;
      },
      set(obj, prop, value) {
        const oldValue = obj[prop];
        obj[prop] = value;
        if (oldValue !== value) {
          scheduleBatch();
        }
        return true;
      },
      deleteProperty(obj, prop) {
        if (prop in obj) {
          delete obj[prop];
          scheduleBatch();
        }
        return true;
      }
    });
  }
  const state = createProxy(initialState, pathPrefix);
  return state;
}
function getStateSnapshot(state) {
  const s = state;
  if (s.__getSnapshot) {
    return s.__getSnapshot();
  }
  return deepClone(state);
}

// src/app.ts
class HypenAppBuilder {
  initialState;
  options;
  createdHandler;
  actionHandlers = new Map;
  destroyedHandler;
  constructor(initialState, options) {
    this.initialState = initialState;
    this.options = options || {};
  }
  onCreated(fn) {
    this.createdHandler = fn;
    return this;
  }
  onAction(name, fn) {
    this.actionHandlers.set(name, fn);
    return this;
  }
  onDestroyed(fn) {
    this.destroyedHandler = fn;
    return this;
  }
  build() {
    return {
      name: this.options.name,
      actions: Array.from(this.actionHandlers.keys()),
      stateKeys: Object.keys(this.initialState),
      persist: this.options.persist,
      version: this.options.version,
      initialState: this.initialState,
      handlers: {
        onCreated: this.createdHandler,
        onAction: this.actionHandlers,
        onDestroyed: this.destroyedHandler
      }
    };
  }
}

class HypenApp {
  defineState(initial, options) {
    return new HypenAppBuilder(initial, options);
  }
}
var app = new HypenApp;

class HypenModuleInstance {
  engine;
  definition;
  state;
  isDestroyed = false;
  routerContext;
  globalContext;
  stateChangeCallbacks = [];
  constructor(engine, definition, routerContext, globalContext) {
    this.engine = engine;
    this.definition = definition;
    this.routerContext = routerContext;
    this.globalContext = globalContext;
    this.state = createObservableState(definition.initialState, {
      onChange: (change) => {
        this.engine.notifyStateChange(change.paths, getStateSnapshot(this.state));
        this.stateChangeCallbacks.forEach((cb) => cb());
      }
    });
    this.engine.setModule(definition.name || "AnonymousModule", definition.actions, definition.stateKeys, getStateSnapshot(this.state));
    for (const [actionName, handler] of definition.handlers.onAction) {
      console.log(`\uD83D\uDCDD [ModuleInstance] Registering action handler: ${actionName} for module ${definition.name}`);
      this.engine.onAction(actionName, async (action) => {
        console.log(`\uD83C\uDFAF [ModuleInstance] Action handler fired: ${actionName}`, action);
        const actionCtx = {
          name: action.name,
          payload: action.payload,
          sender: action.sender
        };
        const next = {
          router: this.routerContext?.root || null
        };
        const context = this.globalContext ? this.createGlobalContextAPI() : undefined;
        try {
          const handlerLength = handler.length;
          if (handlerLength === 1) {
            await handler(actionCtx);
          } else if (handlerLength === 2) {
            await handler(actionCtx, this.state);
          } else if (handlerLength === 3) {
            await handler(actionCtx, this.state, next);
          } else {
            await handler(actionCtx, this.state, next, context);
          }
          console.log(`✅ [ModuleInstance] Action handler completed: ${actionName}`);
        } catch (error) {
          console.error(`❌ [ModuleInstance] Action handler error for ${actionName}:`, error);
        }
      });
    }
    this.callCreatedHandler();
  }
  createGlobalContextAPI() {
    if (!this.globalContext) {
      throw new Error("Global context not available");
    }
    const ctx = this.globalContext;
    const api = {
      getModule: (id) => ctx.getModule(id),
      hasModule: (id) => ctx.hasModule(id),
      getModuleIds: () => ctx.getModuleIds(),
      getGlobalState: () => ctx.getGlobalState(),
      emit: (event, payload) => ctx.emit(event, payload),
      on: (event, handler) => ctx.on(event, handler)
    };
    if (ctx.__router) {
      api.__router = ctx.__router;
    }
    if (ctx.__hypenEngine) {
      api.__hypenEngine = ctx.__hypenEngine;
    }
    return api;
  }
  async callCreatedHandler() {
    if (this.definition.handlers.onCreated) {
      const context = this.globalContext ? this.createGlobalContextAPI() : undefined;
      await this.definition.handlers.onCreated(this.state, context);
    }
  }
  onStateChange(callback) {
    this.stateChangeCallbacks.push(callback);
  }
  async destroy() {
    if (this.isDestroyed)
      return;
    if (this.definition.handlers.onDestroyed) {
      await this.definition.handlers.onDestroyed(this.state);
    }
    this.isDestroyed = true;
  }
  getState() {
    return getStateSnapshot(this.state);
  }
  getLiveState() {
    return this.state;
  }
  updateState(patch) {
    Object.assign(this.state, patch);
  }
}

// src/canvas/utils.ts
function parseSpacing(value) {
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }
  if (typeof value === "string") {
    const parts = value.split(/\s+/).map((v) => parseFloat(v) || 0);
    if (parts.length === 1) {
      return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
    }
    if (parts.length === 2) {
      return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
    }
    if (parts.length === 4) {
      return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
    }
  }
  if (typeof value === "object" && value !== null) {
    return {
      top: parseFloat(value.top) || 0,
      right: parseFloat(value.right) || 0,
      bottom: parseFloat(value.bottom) || 0,
      left: parseFloat(value.left) || 0
    };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}
function parseSize(value) {
  if (typeof value === "number")
    return value;
  if (typeof value === "string") {
    if (value === "auto")
      return null;
    const num = parseFloat(value);
    return isNaN(num) ? null : num;
  }
  return null;
}
function isPointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}
function isPointInRoundedRect(point, rect, radius) {
  const { x, y, width, height } = rect;
  if (!isPointInRect(point, rect))
    return false;
  if (radius <= 0)
    return true;
  const px = point.x;
  const py = point.y;
  if (px < x + radius && py < y + radius) {
    return Math.pow(px - (x + radius), 2) + Math.pow(py - (y + radius), 2) <= Math.pow(radius, 2);
  }
  if (px > x + width - radius && py < y + radius) {
    return Math.pow(px - (x + width - radius), 2) + Math.pow(py - (y + radius), 2) <= Math.pow(radius, 2);
  }
  if (px < x + radius && py > y + height - radius) {
    return Math.pow(px - (x + radius), 2) + Math.pow(py - (y + height - radius), 2) <= Math.pow(radius, 2);
  }
  if (px > x + width - radius && py > y + height - radius) {
    return Math.pow(px - (x + width - radius), 2) + Math.pow(py - (y + height - radius), 2) <= Math.pow(radius, 2);
  }
  return true;
}
function createFontString(fontSize, fontWeight, fontFamily) {
  return `${fontWeight} ${fontSize}px ${fontFamily}`;
}
function getAbsoluteBounds(node) {
  if (!node.layout)
    return null;
  let x = node.layout.x;
  let y = node.layout.y;
  let current = node.parent;
  while (current && current.layout) {
    x += current.layout.contentX;
    y += current.layout.contentY;
    current = current.parent;
  }
  return {
    x,
    y,
    width: node.layout.width,
    height: node.layout.height
  };
}

// src/canvas/text.ts
var textMetricsCache = new Map;
function getCacheKey(text, fontStyle, maxWidth) {
  return `${text}|${fontStyle.fontSize}|${fontStyle.fontWeight}|${fontStyle.fontFamily}|${maxWidth || "auto"}`;
}
function measureText(ctx, text, fontStyle, maxWidth) {
  const cacheKey = getCacheKey(text, fontStyle, maxWidth);
  const cached = textMetricsCache.get(cacheKey);
  if (cached)
    return cached;
  const font = createFontString(fontStyle.fontSize, fontStyle.fontWeight, fontStyle.fontFamily);
  ctx.save();
  ctx.font = font;
  const lineHeight = fontStyle.lineHeight || fontStyle.fontSize * 1.2;
  if (!maxWidth) {
    const metrics = ctx.measureText(text);
    const result2 = {
      width: metrics.width,
      height: lineHeight,
      lines: [text],
      lineHeight
    };
    ctx.restore();
    textMetricsCache.set(cacheKey, result2);
    return result2;
  }
  const lines = wrapText(ctx, text, maxWidth);
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const height = lines.length * lineHeight;
  const result = {
    width,
    height,
    lines,
    lineHeight
  };
  ctx.restore();
  textMetricsCache.set(cacheKey, result);
  return result;
}
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  const paragraphs = text.split(`
`);
  for (const paragraph of paragraphs) {
    const words = paragraph.split(" ");
    let currentLine = "";
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
  }
  return lines.length > 0 ? lines : [""];
}
function renderText(ctx, text, x, y, width, height, style) {
  const font = createFontString(style.fontSize, style.fontWeight, style.fontFamily);
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "top";
  const metrics = measureText(ctx, text, style, width);
  let startY = y;
  if (style.verticalAlign === "middle") {
    startY = y + (height - metrics.height) / 2;
  } else if (style.verticalAlign === "bottom") {
    startY = y + height - metrics.height;
  }
  for (let i = 0;i < metrics.lines.length; i++) {
    const line = metrics.lines[i];
    const lineY = startY + i * metrics.lineHeight;
    let lineX = x;
    if (style.textAlign === "center") {
      const lineWidth = ctx.measureText(line).width;
      lineX = x + (width - lineWidth) / 2;
    } else if (style.textAlign === "right") {
      const lineWidth = ctx.measureText(line).width;
      lineX = x + width - lineWidth;
    }
    ctx.fillText(line, lineX, lineY);
  }
  ctx.restore();
}

// src/canvas/layout.ts
function computeLayout(ctx, node, availableWidth, availableHeight, x = 0, y = 0) {
  const props = node.props;
  const margin = parseSpacing(props.margin || 0);
  const padding = parseSpacing(props.padding || 0);
  const borderWidth = parseFloat(props.borderWidth) || 0;
  const borderColor = props.borderColor || "transparent";
  const borderRadius = parseFloat(props.borderRadius) || 0;
  const availableAfterMargin = {
    width: availableWidth - margin.left - margin.right,
    height: availableHeight - margin.top - margin.bottom
  };
  let width = parseSize(props.width);
  let height = parseSize(props.height);
  if (node.type === "text" && node.props[0]) {
    const text = String(node.props[0] || "");
    const fontSize = parseFloat(props.fontSize) || 16;
    const fontWeight = props.fontWeight || "normal";
    const fontFamily = props.fontFamily || "system-ui, sans-serif";
    const lineHeight = parseFloat(props.lineHeight) || fontSize * 1.2;
    const maxWidth2 = width || availableAfterMargin.width - padding.left - padding.right;
    const metrics = measureText(ctx, text, { fontSize, fontWeight, fontFamily, lineHeight }, maxWidth2);
    if (!width)
      width = metrics.width + padding.left + padding.right;
    if (!height)
      height = metrics.height + padding.top + padding.bottom;
  }
  if (width === null)
    width = availableAfterMargin.width;
  if (height === null)
    height = availableAfterMargin.height;
  const minWidth = parseSize(props.minWidth);
  const maxWidth = parseSize(props.maxWidth);
  const minHeight = parseSize(props.minHeight);
  const maxHeight = parseSize(props.maxHeight);
  if (minWidth !== null)
    width = Math.max(width, minWidth);
  if (maxWidth !== null)
    width = Math.min(width, maxWidth);
  if (minHeight !== null)
    height = Math.max(height, minHeight);
  if (maxHeight !== null)
    height = Math.min(height, maxHeight);
  const layout = {
    x: x + margin.left,
    y: y + margin.top,
    width,
    height,
    margin,
    padding,
    border: {
      width: borderWidth,
      color: borderColor,
      radius: borderRadius
    },
    contentX: padding.left + borderWidth,
    contentY: padding.top + borderWidth,
    contentWidth: width - padding.left - padding.right - borderWidth * 2,
    contentHeight: height - padding.top - padding.bottom - borderWidth * 2
  };
  node.layout = layout;
  if (node.children.length > 0) {
    layoutChildren(ctx, node);
  }
}
function layoutChildren(ctx, parent) {
  const layout = parent.layout;
  const props = parent.props;
  const flexDirection = props.flexDirection || (parent.type === "column" ? "column" : "row");
  const justifyContent = props.justifyContent || "flex-start";
  const alignItems = props.alignItems || "flex-start";
  const gap = parseFloat(props.gap) || 0;
  const isColumn = flexDirection === "column";
  const availableWidth = layout.contentWidth;
  const availableHeight = layout.contentHeight;
  const childSizes = [];
  let totalMainSize = 0;
  for (const child of parent.children) {
    computeLayout(ctx, child, availableWidth, availableHeight, 0, 0);
    const childLayout = child.layout;
    childSizes.push({ width: childLayout.width, height: childLayout.height });
    if (isColumn) {
      totalMainSize += childLayout.height;
    } else {
      totalMainSize += childLayout.width;
    }
  }
  const totalGap = gap * (parent.children.length - 1);
  totalMainSize += totalGap;
  let mainStart = 0;
  let spacing = 0;
  const availableMain = isColumn ? availableHeight : availableWidth;
  const remainingSpace = availableMain - totalMainSize;
  if (justifyContent === "center") {
    mainStart = remainingSpace / 2;
  } else if (justifyContent === "flex-end") {
    mainStart = remainingSpace;
  } else if (justifyContent === "space-between") {
    spacing = remainingSpace / Math.max(1, parent.children.length - 1);
  } else if (justifyContent === "space-around") {
    spacing = remainingSpace / parent.children.length;
    mainStart = spacing / 2;
  }
  let currentMain = mainStart;
  for (let i = 0;i < parent.children.length; i++) {
    const child = parent.children[i];
    const childLayout = child.layout;
    const size = childSizes[i];
    let crossStart = 0;
    const availableCross = isColumn ? availableWidth : availableHeight;
    const childCross = isColumn ? size.width : size.height;
    if (alignItems === "center") {
      crossStart = (availableCross - childCross) / 2;
    } else if (alignItems === "flex-end") {
      crossStart = availableCross - childCross;
    }
    if (isColumn) {
      childLayout.x = layout.x + layout.contentX + crossStart;
      childLayout.y = layout.y + layout.contentY + currentMain;
      currentMain += size.height + gap;
    } else {
      childLayout.x = layout.x + layout.contentX + currentMain;
      childLayout.y = layout.y + layout.contentY + crossStart;
      currentMain += size.width + gap;
    }
    if (justifyContent === "space-between" || justifyContent === "space-around") {
      currentMain += spacing;
    }
  }
}

// src/canvas/paint.ts
var customPainters = new Map;
function registerPainter(type, painter) {
  customPainters.set(type.toLowerCase(), painter);
}
function paintNode(ctx, node) {
  if (!node.visible || !node.layout)
    return;
  ctx.save();
  if (node.opacity < 1) {
    ctx.globalAlpha = node.opacity;
  }
  const customPainter = customPainters.get(node.type.toLowerCase());
  if (customPainter) {
    customPainter(ctx, node);
    ctx.restore();
    return;
  }
  switch (node.type.toLowerCase()) {
    case "column":
    case "row":
      paintContainer(ctx, node);
      break;
    case "text":
      paintText(ctx, node);
      break;
    case "button":
      paintButton(ctx, node);
      break;
    case "input":
      paintInput(ctx, node);
      break;
    case "image":
      paintImage(ctx, node);
      break;
    case "container":
    case "box":
      paintContainer(ctx, node);
      break;
    default:
      paintContainer(ctx, node);
  }
  ctx.restore();
  for (const child of node.children) {
    paintNode(ctx, child);
  }
}
function paintContainer(ctx, node) {
  const layout = node.layout;
  const props = node.props;
  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius;
  const backgroundColor = props.backgroundColor || props.background;
  if (backgroundColor) {
    ctx.fillStyle = backgroundColor;
    if (radius > 0) {
      drawRoundedRect(ctx, x, y, width, height, radius);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, width, height);
    }
  }
  if (layout.border.width > 0 && layout.border.color !== "transparent") {
    ctx.strokeStyle = layout.border.color;
    ctx.lineWidth = layout.border.width;
    if (radius > 0) {
      drawRoundedRect(ctx, x, y, width, height, radius);
      ctx.stroke();
    } else {
      ctx.strokeRect(x, y, width, height);
    }
  }
}
function paintText(ctx, node) {
  const layout = node.layout;
  const props = node.props;
  const text = String(props[0] || props.text || "");
  const color = props.color || "#000000";
  const fontSize = parseFloat(props.fontSize) || 16;
  const fontWeight = props.fontWeight || "normal";
  const fontFamily = props.fontFamily || "system-ui, sans-serif";
  const textAlign = props.textAlign || "left";
  const lineHeight = parseFloat(props.lineHeight) || fontSize * 1.2;
  renderText(ctx, text, layout.x + layout.contentX, layout.y + layout.contentY, layout.contentWidth, layout.contentHeight, {
    color,
    fontSize,
    fontWeight,
    fontFamily,
    textAlign,
    verticalAlign: "top",
    lineHeight
  });
}
function paintButton(ctx, node) {
  const layout = node.layout;
  const props = node.props;
  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius || 4;
  let backgroundColor = props.backgroundColor || "#007bff";
  if (node.hovered) {
    backgroundColor = props.hoverColor || "#0056b3";
  }
  if (node.focused) {
    backgroundColor = props.focusColor || "#004085";
  }
  ctx.fillStyle = backgroundColor;
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();
  if (layout.border.width > 0) {
    ctx.strokeStyle = layout.border.color;
    ctx.lineWidth = layout.border.width;
    drawRoundedRect(ctx, x, y, width, height, radius);
    ctx.stroke();
  }
  for (const child of node.children) {
    paintNode(ctx, child);
  }
}
function paintInput(ctx, node) {
  const layout = node.layout;
  const props = node.props;
  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius || 4;
  ctx.fillStyle = props.backgroundColor || "#ffffff";
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();
  const borderColor = node.focused ? "#007bff" : layout.border.color || "#cccccc";
  const borderWidth = node.focused ? 2 : layout.border.width || 1;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = borderWidth;
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.stroke();
  const value = props.value || "";
  const placeholder = props.placeholder || "";
  const text = value || placeholder;
  const textColor = value ? props.color || "#000000" : "#999999";
  if (text) {
    const fontSize = parseFloat(props.fontSize) || 16;
    const fontWeight = props.fontWeight || "normal";
    const fontFamily = props.fontFamily || "system-ui, sans-serif";
    const lineHeight = parseFloat(props.lineHeight) || fontSize * 1.2;
    renderText(ctx, text, layout.x + layout.contentX, layout.y + layout.contentY, layout.contentWidth, layout.contentHeight, {
      color: textColor,
      fontSize,
      fontWeight,
      fontFamily,
      textAlign: "left",
      verticalAlign: "middle",
      lineHeight
    });
  }
}
function paintImage(ctx, node) {
  const layout = node.layout;
  const props = node.props;
  const src = props.src || props[0];
  if (!src)
    return;
  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  ctx.fillStyle = "#e0e0e0";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "#999999";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = "#666666";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("IMG", x + width / 2, y + height / 2);
}
function drawRoundedRect(ctx, x, y, width, height, radius) {
  if (radius <= 0) {
    ctx.rect(x, y, width, height);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.arcTo(x + width, y, x + width, y + radius, radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  ctx.lineTo(x + radius, y + height);
  ctx.arcTo(x, y + height, x, y + height - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

// src/canvas/events.ts
class CanvasEventManager {
  canvas;
  engine;
  rootNode = null;
  hoveredNode = null;
  focusedNode = null;
  mouseDownNode = null;
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.setupEventListeners();
  }
  setRootNode(node) {
    this.rootNode = node;
  }
  setupEventListeners() {
    this.canvas.addEventListener("mousemove", this.onMouseMove.bind(this));
    this.canvas.addEventListener("mousedown", this.onMouseDown.bind(this));
    this.canvas.addEventListener("mouseup", this.onMouseUp.bind(this));
    this.canvas.addEventListener("click", this.onClick.bind(this));
    this.canvas.addEventListener("dblclick", this.onDoubleClick.bind(this));
    this.canvas.addEventListener("keydown", this.onKeyDown.bind(this));
    this.canvas.addEventListener("keyup", this.onKeyUp.bind(this));
  }
  getCanvasCoordinates(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }
  hitTest(point) {
    if (!this.rootNode)
      return null;
    return this.hitTestNode(this.rootNode, point);
  }
  hitTestNode(node, point) {
    if (!node.visible || !node.layout)
      return null;
    const bounds = getAbsoluteBounds(node);
    if (!bounds)
      return null;
    for (let i = node.children.length - 1;i >= 0; i--) {
      const child = node.children[i];
      const hit = this.hitTestNode(child, point);
      if (hit)
        return hit;
    }
    const radius = node.layout.border.radius;
    if (isPointInRoundedRect(point, bounds, radius)) {
      return node;
    }
    return null;
  }
  onMouseMove(e) {
    const point = this.getCanvasCoordinates(e);
    const node = this.hitTest(point);
    if (node !== this.hoveredNode) {
      if (this.hoveredNode) {
        this.hoveredNode.hovered = false;
        this.dispatchNodeEvent(this.hoveredNode, "mouseleave", {});
      }
      this.hoveredNode = node;
      if (node) {
        node.hovered = true;
        this.dispatchNodeEvent(node, "mouseenter", {});
      }
      this.updateCursor(node);
      this.requestRedraw();
    }
  }
  onMouseDown(e) {
    const point = this.getCanvasCoordinates(e);
    const node = this.hitTest(point);
    this.mouseDownNode = node;
    if (node && node.clickable) {
      this.dispatchNodeEvent(node, "mousedown", {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY
      });
    }
    if (node && node.focusable) {
      this.setFocus(node);
    } else {
      this.setFocus(null);
    }
  }
  onMouseUp(e) {
    const point = this.getCanvasCoordinates(e);
    const node = this.hitTest(point);
    if (node && node.clickable) {
      this.dispatchNodeEvent(node, "mouseup", {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY
      });
    }
    this.mouseDownNode = null;
  }
  onClick(e) {
    const point = this.getCanvasCoordinates(e);
    const node = this.hitTest(point);
    if (node && node.clickable && node === this.mouseDownNode) {
      this.dispatchNodeEvent(node, "click", {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY
      });
    }
  }
  onDoubleClick(e) {
    const point = this.getCanvasCoordinates(e);
    const node = this.hitTest(point);
    if (node && node.clickable) {
      this.dispatchNodeEvent(node, "dblclick", {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY
      });
    }
  }
  onKeyDown(e) {
    if (this.focusedNode) {
      this.dispatchNodeEvent(this.focusedNode, "keydown", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey
      });
    }
  }
  onKeyUp(e) {
    if (this.focusedNode) {
      this.dispatchNodeEvent(this.focusedNode, "keyup", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey
      });
    }
  }
  setFocus(node) {
    if (node === this.focusedNode)
      return;
    if (this.focusedNode) {
      this.focusedNode.focused = false;
      this.dispatchNodeEvent(this.focusedNode, "blur", {});
    }
    this.focusedNode = node;
    if (node) {
      node.focused = true;
      this.dispatchNodeEvent(node, "focus", {});
    }
    this.requestRedraw();
  }
  updateCursor(node) {
    if (!node) {
      this.canvas.style.cursor = "default";
      return;
    }
    const cursor = node.props.cursor || (node.clickable ? "pointer" : "default");
    this.canvas.style.cursor = cursor;
  }
  dispatchNodeEvent(node, eventType, data) {
    const actionName = node.props[`on${eventType}`] || node.props[eventType];
    if (actionName && typeof actionName === "string") {
      this.engine.dispatchAction(actionName, {
        type: eventType,
        nodeId: node.id,
        timestamp: Date.now(),
        ...data
      });
    }
  }
  requestRedraw() {
    this.canvas.dispatchEvent(new CustomEvent("hypen:redraw"));
  }
  destroy() {}
}

// src/canvas/input.ts
class InputOverlay {
  container;
  overlay = null;
  focusedNode = null;
  onChangeCallback = null;
  constructor(container) {
    this.container = container || {};
  }
  showInput(node, canvasBounds, onChange) {
    if (typeof document === "undefined")
      return;
    this.hideInput();
    const bounds = getAbsoluteBounds(node);
    if (!bounds)
      return;
    const isMultiline = node.type === "textarea";
    this.overlay = isMultiline ? document.createElement("textarea") : document.createElement("input");
    this.styleOverlay(node, bounds, canvasBounds);
    const value = node.props.value || "";
    this.overlay.value = value;
    this.onChangeCallback = onChange;
    this.overlay.addEventListener("input", this.onInput.bind(this));
    this.overlay.addEventListener("blur", this.onBlur.bind(this));
    this.overlay.addEventListener("keydown", this.onKeyDown.bind(this));
    this.container.appendChild(this.overlay);
    this.overlay.focus();
    this.focusedNode = node;
  }
  hideInput() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    this.focusedNode = null;
    this.onChangeCallback = null;
  }
  updatePosition(node, canvasBounds) {
    if (!this.overlay || node !== this.focusedNode)
      return;
    const bounds = getAbsoluteBounds(node);
    if (!bounds)
      return;
    this.positionOverlay(bounds, canvasBounds);
  }
  styleOverlay(node, bounds, canvasBounds) {
    if (!this.overlay)
      return;
    const props = node.props;
    this.positionOverlay(bounds, canvasBounds);
    const fontSize = parseFloat(props.fontSize) || 16;
    const fontWeight = props.fontWeight || "normal";
    const fontFamily = props.fontFamily || "system-ui, sans-serif";
    const color = props.color || "#000000";
    Object.assign(this.overlay.style, {
      fontSize: `${fontSize}px`,
      fontWeight,
      fontFamily,
      color,
      border: "none",
      outline: "2px solid #007bff",
      backgroundColor: props.backgroundColor || "#ffffff",
      padding: `${props.padding || 8}px`,
      borderRadius: `${props.borderRadius || 4}px`,
      boxSizing: "border-box",
      resize: "none"
    });
    if (props.placeholder) {
      this.overlay.placeholder = props.placeholder;
    }
    if (this.overlay instanceof HTMLInputElement && props.type) {
      this.overlay.type = props.type;
    }
  }
  positionOverlay(bounds, canvasBounds) {
    if (!this.overlay)
      return;
    const canvas = this.container.querySelector("canvas");
    const scaleX = canvasBounds.width / canvas.width;
    const scaleY = canvasBounds.height / canvas.height;
    const left = bounds.x * scaleX;
    const top = bounds.y * scaleY;
    const width = bounds.width * scaleX;
    const height = bounds.height * scaleY;
    Object.assign(this.overlay.style, {
      position: "absolute",
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`
    });
  }
  onInput(e) {
    if (!this.overlay || !this.onChangeCallback)
      return;
    const value = this.overlay.value;
    this.onChangeCallback(value);
  }
  onBlur() {
    this.hideInput();
  }
  onKeyDown(e) {
    if (!this.overlay)
      return;
    if (e.key === "Enter" && this.overlay instanceof HTMLInputElement) {
      e.preventDefault();
      this.overlay.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.overlay.blur();
    }
  }
  isShown() {
    return this.overlay !== null;
  }
  getFocusedNode() {
    return this.focusedNode;
  }
}

// src/canvas/accessibility.ts
class AccessibilityLayer {
  shadowRoot;
  nodeMap = new Map;
  enabled;
  constructor(container, enabled = true) {
    this.enabled = enabled && typeof document !== "undefined";
    if (this.enabled && typeof document !== "undefined") {
      this.shadowRoot = document.createElement("div");
      this.shadowRoot.setAttribute("role", "application");
      this.shadowRoot.setAttribute("aria-label", "Hypen Canvas Application");
      this.shadowRoot.style.position = "absolute";
      this.shadowRoot.style.left = "-9999px";
      this.shadowRoot.style.width = "1px";
      this.shadowRoot.style.height = "1px";
      this.shadowRoot.style.overflow = "hidden";
      if (container) {
        container.appendChild(this.shadowRoot);
      }
    } else {
      this.shadowRoot = {};
    }
  }
  syncTree(root) {
    if (!this.enabled)
      return;
    this.shadowRoot.innerHTML = "";
    this.nodeMap.clear();
    const shadowNode = this.createShadowNode(root);
    if (shadowNode) {
      this.shadowRoot.appendChild(shadowNode);
    }
  }
  createShadowNode(node) {
    if (!node.visible)
      return null;
    let element;
    switch (node.type.toLowerCase()) {
      case "button":
        element = document.createElement("button");
        element.textContent = this.getNodeText(node);
        if (node.props.onclick) {
          element.setAttribute("aria-label", "Clickable button");
        }
        break;
      case "input":
        element = document.createElement("input");
        element.type = node.props.type || "text";
        element.value = node.props.value || "";
        if (node.props.placeholder) {
          element.placeholder = node.props.placeholder;
        }
        break;
      case "textarea":
        element = document.createElement("textarea");
        element.value = node.props.value || "";
        if (node.props.placeholder) {
          element.placeholder = node.props.placeholder;
        }
        break;
      case "image":
        element = document.createElement("img");
        element.src = node.props.src || "";
        element.alt = node.props.alt || "Image";
        break;
      case "text":
        element = document.createElement("span");
        element.textContent = String(node.props[0] || node.props.text || "");
        break;
      case "column":
      case "row":
      case "container":
      case "box":
        element = document.createElement("div");
        element.setAttribute("role", node.type === "column" ? "group" : "group");
        break;
      default:
        element = document.createElement("div");
    }
    element.setAttribute("data-hypen-id", node.id);
    if (node.props["aria-label"]) {
      element.setAttribute("aria-label", node.props["aria-label"]);
    }
    if (node.focusable) {
      element.tabIndex = 0;
    }
    this.nodeMap.set(node.id, element);
    for (const child of node.children) {
      const childElement = this.createShadowNode(child);
      if (childElement) {
        element.appendChild(childElement);
      }
    }
    return element;
  }
  getNodeText(node) {
    if (node.type === "text") {
      return String(node.props[0] || node.props.text || "");
    }
    let text = "";
    for (const child of node.children) {
      text += this.getNodeText(child);
    }
    return text;
  }
  focusNode(nodeId) {
    if (!this.enabled)
      return;
    const element = this.nodeMap.get(nodeId);
    if (element) {
      element.focus();
    }
  }
  updateNode(node) {
    if (!this.enabled)
      return;
    const element = this.nodeMap.get(node.id);
    if (!element)
      return;
    if (node.type === "text") {
      element.textContent = String(node.props[0] || node.props.text || "");
    }
    if (node.type === "input" || node.type === "textarea") {
      element.value = node.props.value || "";
    }
    element.style.display = node.visible ? "" : "none";
  }
  getElement(nodeId) {
    return this.nodeMap.get(nodeId);
  }
  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled && this.shadowRoot.parentElement) {
      this.shadowRoot.remove();
    }
  }
  destroy() {
    if (this.shadowRoot.parentElement) {
      this.shadowRoot.remove();
    }
    this.nodeMap.clear();
  }
}

// src/canvas/renderer.ts
var DEFAULT_OPTIONS = {
  devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  backgroundColor: "#ffffff",
  enableAccessibility: true,
  enableHitTesting: true,
  enableInputOverlay: true,
  enableDirtyRects: false,
  enableLayerCaching: false,
  maxLayerCacheSize: 10,
  showLayoutBounds: false,
  showDirtyRects: false,
  logPerformance: false
};

class CanvasRenderer {
  canvas;
  ctx;
  engine;
  options;
  rootNode = null;
  nodes = new Map;
  eventManager;
  inputOverlay;
  accessibilityLayer;
  rafId = null;
  needsRedraw = false;
  frameCount = 0;
  lastFrameTime = 0;
  constructor(canvas, engine, options) {
    this.canvas = canvas;
    this.engine = engine;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get 2D context from canvas");
    }
    this.ctx = ctx;
    this.setupHiDPI();
    this.eventManager = new CanvasEventManager(canvas, engine);
    this.inputOverlay = new InputOverlay(canvas.parentElement || (typeof document !== "undefined" ? document.body : null));
    this.accessibilityLayer = new AccessibilityLayer(canvas.parentElement || (typeof document !== "undefined" ? document.body : null), this.options.enableAccessibility || false);
    this.canvas.addEventListener("hypen:redraw", () => this.scheduleRedraw());
  }
  setupHiDPI() {
    const dpr = this.options.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
  }
  applyPatches(patches) {
    for (const patch of patches) {
      this.applyPatch(patch);
    }
    if (this.rootNode) {
      this.accessibilityLayer.syncTree(this.rootNode);
    }
    this.scheduleRedraw();
  }
  applyPatch(patch) {
    switch (patch.type) {
      case "create":
        this.onCreate(patch.id, patch.element_type, patch.props || {});
        break;
      case "setProp":
        this.onSetProp(patch.id, patch.name, patch.value);
        break;
      case "setText":
        this.onSetText(patch.id, patch.text);
        break;
      case "insert":
        this.onInsert(patch.parent_id, patch.id, patch.before_id);
        break;
      case "move":
        this.onMove(patch.parent_id, patch.id, patch.before_id);
        break;
      case "remove":
        this.onRemove(patch.id);
        break;
    }
  }
  onCreate(id, elementType, props) {
    const node = {
      id,
      type: elementType,
      props: props instanceof Map ? Object.fromEntries(props) : props,
      children: [],
      parent: null,
      visible: true,
      opacity: parseFloat(props.opacity) || 1,
      clickable: elementType === "button" || !!props.onclick,
      hoverable: true,
      focusable: elementType === "input" || elementType === "textarea" || elementType === "button",
      focused: false,
      hovered: false
    };
    this.nodes.set(id, node);
  }
  onSetProp(id, name, value) {
    const node = this.nodes.get(id);
    if (!node)
      return;
    node.props[name] = value;
    if (name === "visible") {
      node.visible = !!value;
    }
    if (name === "opacity") {
      node.opacity = parseFloat(value) || 1;
    }
    this.accessibilityLayer.updateNode(node);
  }
  onSetText(id, text) {
    const node = this.nodes.get(id);
    if (!node)
      return;
    node.props[0] = text;
    this.accessibilityLayer.updateNode(node);
  }
  onInsert(parentId, id, beforeId) {
    const child = this.nodes.get(id);
    if (!child)
      return;
    if (parentId === "root" && id === "root") {
      this.rootNode = child;
      this.eventManager.setRootNode(child);
      return;
    }
    const parent = this.nodes.get(parentId);
    if (!parent) {
      if (parentId === "root") {
        this.rootNode = child;
        this.eventManager.setRootNode(child);
      }
      return;
    }
    child.parent = parent;
    if (beforeId) {
      const beforeIndex = parent.children.findIndex((c) => c.id === beforeId);
      if (beforeIndex >= 0) {
        parent.children.splice(beforeIndex, 0, child);
      } else {
        parent.children.push(child);
      }
    } else {
      parent.children.push(child);
    }
  }
  onMove(parentId, id, beforeId) {
    const node = this.nodes.get(id);
    if (!node || !node.parent)
      return;
    const oldParent = node.parent;
    const oldIndex = oldParent.children.indexOf(node);
    if (oldIndex >= 0) {
      oldParent.children.splice(oldIndex, 1);
    }
    this.onInsert(parentId, id, beforeId);
  }
  onRemove(id) {
    const node = this.nodes.get(id);
    if (!node)
      return;
    if (node.parent) {
      const index = node.parent.children.indexOf(node);
      if (index >= 0) {
        node.parent.children.splice(index, 1);
      }
    }
    if (this.rootNode === node) {
      this.rootNode = null;
      this.eventManager.setRootNode(null);
    }
    this.nodes.delete(id);
  }
  scheduleRedraw() {
    if (this.rafId !== null)
      return;
    if (typeof requestAnimationFrame !== "undefined") {
      this.rafId = requestAnimationFrame(() => {
        this.render();
        this.rafId = null;
      });
    } else {
      this.render();
    }
  }
  render() {
    const startTime = performance.now();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.options.backgroundColor) {
      this.ctx.fillStyle = this.options.backgroundColor;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (this.rootNode) {
      const dpr = this.options.devicePixelRatio || 1;
      computeLayout(this.ctx, this.rootNode, this.canvas.width / dpr, this.canvas.height / dpr);
      paintNode(this.ctx, this.rootNode);
      if (this.options.showLayoutBounds) {
        this.drawLayoutBounds(this.rootNode);
      }
    }
    if (this.options.logPerformance) {
      const elapsed = performance.now() - startTime;
      this.frameCount++;
      if (performance.now() - this.lastFrameTime > 1000) {
        console.log(`Canvas FPS: ${this.frameCount}, Last frame: ${elapsed.toFixed(2)}ms`);
        this.frameCount = 0;
        this.lastFrameTime = performance.now();
      }
    }
  }
  drawLayoutBounds(node) {
    if (!node.layout)
      return;
    const layout = node.layout;
    this.ctx.strokeStyle = "#ff0000";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(layout.x, layout.y, layout.width, layout.height);
    for (const child of node.children) {
      this.drawLayoutBounds(child);
    }
  }
  getNode(id) {
    return this.nodes.get(id);
  }
  clear() {
    this.rootNode = null;
    this.nodes.clear();
    this.eventManager.setRootNode(null);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  registerPainter(type, painter) {
    registerPainter(type, painter);
  }
  setOptions(options) {
    this.options = { ...this.options, ...options };
    this.accessibilityLayer.setEnabled(this.options.enableAccessibility || false);
  }
  destroy() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    this.eventManager.destroy();
    this.accessibilityLayer.destroy();
  }
}
// examples/canvas-counter.ts
var counterModule = app.defineState({ count: 0 }).onCreated(async (state) => {
  console.log("Counter created with canvas renderer");
}).onAction("increment", async (action, state) => {
  state.count++;
  console.log(`Count: ${state.count}`);
}).onAction("decrement", async (action, state) => {
  state.count--;
  console.log(`Count: ${state.count}`);
}).onAction("reset", async (action, state) => {
  state.count = 0;
  console.log("Counter reset");
}).build();
var ui = `
Column {
  Text("Canvas Counter")
    .fontSize(24)
    .fontWeight("bold")
    .color("#333333")
    .marginBottom(16)
  
  Row {
    Button {
      Text("-")
        .color("white")
        .fontSize(18)
        .fontWeight("bold")
    }
      .padding(10)
      .backgroundColor("#dc3545")
      .borderRadius(4)
      .marginRight(10)
      .onClick("@actions.decrement")
    
    Text("@{state.count}")
      .fontSize(32)
      .fontWeight("bold")
      .color("#007bff")
      .padding(10)
      .marginRight(10)
    
    Button {
      Text("+")
        .color("white")
        .fontSize(18)
        .fontWeight("bold")
    }
      .padding(10)
      .backgroundColor("#28a745")
      .borderRadius(4)
      .onClick("@actions.increment")
  }
    .gap(10)
    .marginBottom(10)
  
  Button {
    Text("Reset")
      .color("white")
      .fontSize(16)
  }
    .padding(10)
    .backgroundColor("#6c757d")
    .borderRadius(4)
    .onClick("@actions.reset")
    .marginBottom(10)
  
  Text("Rendered with Canvas")
    .fontSize(12)
    .color("#666666")
}
  .padding(20)
  .gap(10)
  .backgroundColor("#f5f5f5")
`;
async function main() {
  console.log("Starting canvas counter example...");
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  canvas.style.border = "1px solid #cccccc";
  canvas.style.display = "block";
  canvas.style.margin = "20px auto";
  document.body.appendChild(canvas);
  const engine = new Engine;
  await engine.init();
  console.log("Engine initialized");
  const renderer = new CanvasRenderer(canvas, engine, {
    devicePixelRatio: window.devicePixelRatio,
    backgroundColor: "#ffffff",
    enableAccessibility: true,
    enableHitTesting: true,
    enableInputOverlay: true,
    showLayoutBounds: false,
    logPerformance: true
  });
  console.log("Canvas renderer created");
  engine.setRenderCallback((patches) => {
    console.log(`Applying ${patches.length} patches`);
    console.log("Patches:", patches);
    renderer.applyPatches(patches);
    console.log("Root node:", renderer.rootNode);
    console.log("Total nodes:", renderer.nodes.size);
  });
  const instance = new HypenModuleInstance(engine, counterModule);
  console.log("Module instance created");
  await engine.renderSource(ui);
  console.log("UI rendered");
  const instructions = document.createElement("div");
  instructions.style.textAlign = "center";
  instructions.style.marginTop = "20px";
  instructions.style.fontFamily = "system-ui, sans-serif";
  instructions.style.color = "#666666";
  instructions.innerHTML = `
    <h2>Canvas Renderer Demo</h2>
    <p>Click the buttons to interact with the counter.</p>
    <p>All UI is rendered using Canvas 2D API - no DOM elements!</p>
  `;
  document.body.appendChild(instructions);
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
