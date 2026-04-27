import { app } from "@hypen-space/core";

export default app
  .defineState({
    id: 0,
    name: "Product Name",
    description: "Product description goes here",
    price: 99.99,
  })
  .onAction("addToCart", ({ state }) => {
    console.log(`Added ${state.name} to cart`);
    alert(`Added ${state.name} to cart!`);
  })
  .build();
