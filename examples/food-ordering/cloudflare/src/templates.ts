// @ts-ignore
import appTpl from "./components/App.hypen";
// @ts-ignore
import bottomNavTpl from "./components/BottomNav.hypen";
// @ts-ignore
import cartTpl from "./components/Cart.hypen";
// @ts-ignore
import cartItemTpl from "./components/CartItem.hypen";
// @ts-ignore
import categoryChipTpl from "./components/CategoryChip.hypen";
// @ts-ignore
import homePageTpl from "./components/HomePage.hypen";
// @ts-ignore
import menuItemTpl from "./components/MenuItem.hypen";
// @ts-ignore
import orderDetailTpl from "./components/OrderDetail.hypen";
// @ts-ignore
import ordersTpl from "./components/Orders.hypen";
// @ts-ignore
import profileTpl from "./components/Profile.hypen";
// @ts-ignore
import restaurantCardTpl from "./components/RestaurantCard.hypen";
// @ts-ignore
import restaurantDetailTpl from "./components/RestaurantDetail.hypen";
// @ts-ignore
import searchTpl from "./components/Search.hypen";

export const appTemplate = appTpl as string;

export const templates: Record<string, string> = {
  App: appTpl as string,
  BottomNav: bottomNavTpl as string,
  Cart: cartTpl as string,
  CartItem: cartItemTpl as string,
  CategoryChip: categoryChipTpl as string,
  HomePage: homePageTpl as string,
  MenuItem: menuItemTpl as string,
  OrderDetail: orderDetailTpl as string,
  Orders: ordersTpl as string,
  Profile: profileTpl as string,
  RestaurantCard: restaurantCardTpl as string,
  RestaurantDetail: restaurantDetailTpl as string,
  Search: searchTpl as string,
};
