/**
 * Compile-time only: the TS shim's `context.http` is what `@hypen-space/core`
 * tells module authors it is.
 *
 * The shim (`shims/module-shim.ts`) runs inside the guest and may import
 * nothing, so it declares its own `ShimHttp`; authors type their handlers
 * with core's `GlobalContext["http"]` (`ModuleHttp`). Nothing at run time
 * ties the two together — these assertions do, under `tsc --noEmit`: if
 * either side changes shape, this file stops compiling.
 */

import type { HttpCompletion, ModuleHttp, ModuleHttpErrorCode } from "@hypen-space/core";
import type { ShimHttp, ShimHttpErrorCode } from "./shims/module-shim.js";

type Assert<T extends true> = T;

/** What the shim provides can be used wherever an author expects `ModuleHttp`… */
export type ShimHttpIsModuleHttp = Assert<ShimHttp extends ModuleHttp ? true : false>;
/** …and accepts every call core's type allows. */
export type ModuleHttpIsShimHttp = Assert<ModuleHttp extends ShimHttp ? true : false>;
/** Every code the shim throws is one core documents. */
export type ShimErrorCodesAreDocumented = Assert<ShimHttpErrorCode extends ModuleHttpErrorCode ? true : false>;
/** The completion payload type authors cast `action.payload` to exists and discriminates on `ok`. */
export type CompletionDiscriminatesOnOk = Assert<HttpCompletion["ok"] extends boolean ? true : false>;
