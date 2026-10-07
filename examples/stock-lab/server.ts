import { RemoteServer } from "../../hypen-web/packages/server/src/remote/server";
import { app } from "@hypen-space/core/app";
import module from "./App";
import { icons } from "./icons";
const port = Number(process.env.PORT || 3188);
await new RemoteServer().app(app).module("App", module).ui(module.template!).resources(icons)
  .config({ port }).session({ ttl: 3600 }).listen();
console.log(`Orbit stock lab: ws://localhost:${port}`);
