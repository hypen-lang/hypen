import { app } from "@hypen-space/core";

export default app
  .defineState({
    counter: 0,
    message: "Click the buttons to change the counter!",
  })
  .onAction("increment", ({ state }) => {
    state.counter += 1;
    state.message = state.counter > 10
      ? "Wow! You're really clicking!"
      : state.counter > 5
      ? "Keep going!"
      : "Nice clicking!";
  })
  .onAction("decrement", ({ state }) => {
    state.counter -= 1;
    state.message = state.counter < 0
      ? "Going negative!"
      : state.counter === 0
      ? "Back to zero!"
      : "Counting down...";
  })
  .onAction("reset", ({ state }) => {
    state.counter = 0;
    state.message = "Counter reset!";
  })
  .onAction("navigateProducts", ({ context }) => {
    context.router?.push("/products");
  })
  .onAction("navigateAbout", ({ context }) => {
    context.router?.push("/about");
  })
  .build();
