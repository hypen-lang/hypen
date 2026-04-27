/**
 * Type declarations for .hypen file imports
 */
declare module "*.hypen" {
  import type { HypenModuleDefinition } from "@hypen-space/core";

  export const module: HypenModuleDefinition;
  export const template: string;
  export const name: string;

  const component: {
    module: HypenModuleDefinition;
    template: string;
    name: string;
  };
  export default component;
}
