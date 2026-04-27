/**
 * Preload file for Hypen Studio
 * Registers the Hypen plugin for .hypen file imports
 */
import { registerHypenPlugin } from "@hypen-space/server";

registerHypenPlugin({ debug: false });
