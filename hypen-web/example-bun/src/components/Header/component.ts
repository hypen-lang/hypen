import { app } from "@hypen-space/core";

export default app
  .defineState({})
  .onAction("navigateHome", ({ context }) => {
    context.router?.push("/");
  })
  .onAction("navigateProducts", ({ context }) => {
    context.router?.push("/products");
  })
  .onAction("navigateAbout", ({ context }) => {
    context.router?.push("/about");
  })
  .onAction("navigateCart", ({ context }) => {
    context.router?.push("/cart");
  })
  .build();
