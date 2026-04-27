-- Users
INSERT INTO users (id, name, email, avatar_url, address, phone) VALUES
('u1', 'Alex Morgan', 'alex@example.com', 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&h=150&fit=crop', '221B Baker Street, Apt 4, Brooklyn, NY 11201', '+1 (555) 123-4567');

-- Categories
INSERT INTO categories (id, name, icon) VALUES
('cat_all',     'All',      'utensils'),
('cat_pizza',   'Pizza',    'pizza'),
('cat_burger',  'Burgers',  'burger'),
('cat_sushi',   'Sushi',    'fish'),
('cat_asian',   'Asian',    'noodles'),
('cat_mex',     'Mexican',  'taco'),
('cat_desert',  'Dessert',  'ice-cream'),
('cat_coffee',  'Coffee',   'coffee');

-- Restaurants
INSERT INTO restaurants (id, name, cuisine, image_url, rating, rating_count, delivery_time_min, delivery_time_max, delivery_fee, distance_km, is_open, description, category_id) VALUES
('r1',  'Napoli Pizzeria',       'Italian',        'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=800&h=600&fit=crop',     4.8, 2043, 20, 30, 2.99, 1.2, 1, 'Wood-fired Neapolitan pizza made with San Marzano tomatoes and fresh mozzarella.', 'cat_pizza'),
('r2',  'Smash & Stack',         'American',       'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800&h=600&fit=crop',     4.6, 1580, 15, 25, 1.99, 0.8, 1, 'Smash burgers with hand-cut fries and milkshakes.',                                 'cat_burger'),
('r3',  'Sakura Sushi Bar',      'Japanese',       'https://images.unsplash.com/photo-1579871494447-9811cf80d66c?w=800&h=600&fit=crop',     4.9, 3120, 25, 40, 3.99, 2.1, 1, 'Omakase-grade sushi delivered straight to your door.',                              'cat_sushi'),
('r4',  'Bangkok Wok',           'Thai',           'https://images.unsplash.com/photo-1559314809-0d155014e29e?w=800&h=600&fit=crop',        4.5,  910, 20, 35, 2.49, 1.7, 1, 'Authentic Thai street food with bold flavors.',                                      'cat_asian'),
('r5',  'El Jefe Taqueria',      'Mexican',        'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=800&h=600&fit=crop',     4.7, 1340, 15, 25, 1.49, 0.9, 1, 'Tacos al pastor, burritos, and handmade salsas.',                                    'cat_mex'),
('r6',  'Scoops Ice Cream',      'Dessert',        'https://images.unsplash.com/photo-1501443762994-82bd5dace89a?w=800&h=600&fit=crop',     4.4,  620, 10, 20, 0.99, 0.5, 1, 'Small-batch ice cream and gelato made fresh daily.',                                 'cat_desert'),
('r7',  'Daily Grind Cafe',      'Coffee & Bakery','https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=800&h=600&fit=crop',     4.6,  890, 10, 20, 1.49, 0.7, 1, 'Specialty coffee, pastries, and all-day brunch.',                                    'cat_coffee'),
('r8',  'Dragon Garden',         'Chinese',        'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=800&h=600&fit=crop',        4.3,  720, 25, 40, 2.99, 2.4, 0, 'Classic Cantonese and Sichuan dishes.',                                              'cat_asian'),
('r9',  'Pizza & Co.',           'Italian',        'https://images.unsplash.com/photo-1571091718767-18b5b1457add?w=800&h=600&fit=crop',     4.2,  410, 25, 40, 2.49, 1.5, 1, 'New York style slices, pies, and garlic knots.',                                     'cat_pizza'),
('r10', 'Burger Barn',           'American',       'https://images.unsplash.com/photo-1586190848861-99aa4a171e90?w=800&h=600&fit=crop',     4.5,  780, 20, 30, 1.99, 1.1, 1, 'Grass-fed beef burgers, loaded fries, and shakes.',                                  'cat_burger');

-- Menu items
INSERT INTO menu_items (id, restaurant_id, name, description, image_url, price, is_vegetarian, is_popular, section) VALUES
('m101', 'r1', 'Margherita',             'Tomato, fresh mozzarella, basil, extra virgin olive oil.',               'https://images.unsplash.com/photo-1604068549290-dea0e4a305ca?w=600&h=600&fit=crop',   14.50, 1, 1, 'Pizzas'),
('m102', 'r1', 'Pepperoni',              'Tomato, mozzarella, spicy pepperoni.',                                    'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=600&h=600&fit=crop',   16.00, 0, 1, 'Pizzas'),
('m103', 'r1', 'Quattro Formaggi',       'Four cheese blend, honey drizzle.',                                       'https://images.unsplash.com/photo-1548369937-47519962c11a?w=600&h=600&fit=crop',       17.50, 1, 0, 'Pizzas'),
('m104', 'r1', 'Caprese Salad',          'Tomato, buffalo mozzarella, basil, balsamic.',                            'https://images.unsplash.com/photo-1608897013039-887f21d8c804?w=600&h=600&fit=crop',   10.00, 1, 0, 'Starters'),
('m105', 'r1', 'Tiramisu',               'House-made classic tiramisu.',                                            'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=600&h=600&fit=crop',    8.00, 1, 0, 'Desserts'),

('m201', 'r2', 'Classic Smash',          'Double smashed patty, American cheese, pickles, house sauce.',            'https://images.unsplash.com/photo-1550317138-10000687a72b?w=600&h=600&fit=crop',     12.00, 0, 1, 'Burgers'),
('m202', 'r2', 'Bacon Smash',            'Smashed patty, bacon, aged cheddar, caramelized onion.',                  'https://images.unsplash.com/photo-1553979459-d2229ba7433b?w=600&h=600&fit=crop',     14.50, 0, 1, 'Burgers'),
('m203', 'r2', 'Mushroom Melt',          'Beef, Swiss cheese, sauteed mushrooms, aioli.',                           'https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?w=600&h=600&fit=crop',   13.50, 0, 0, 'Burgers'),
('m204', 'r2', 'Crinkle Fries',          'Crispy golden fries with sea salt.',                                      'https://images.unsplash.com/photo-1630384060421-cb20d0e0649d?w=600&h=600&fit=crop',    4.50, 1, 0, 'Sides'),
('m205', 'r2', 'Vanilla Shake',          'Hand-spun vanilla milkshake.',                                            'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=600&h=600&fit=crop',    5.50, 1, 0, 'Drinks'),

('m301', 'r3', 'Salmon Nigiri (6pc)',    'Fresh salmon over seasoned rice.',                                        'https://images.unsplash.com/photo-1553621042-f6e147245754?w=600&h=600&fit=crop',     15.00, 0, 1, 'Nigiri'),
('m302', 'r3', 'Tuna Roll',              'Fresh tuna, nori, sushi rice.',                                           'https://images.unsplash.com/photo-1617196034796-73dfa7b1fd56?w=600&h=600&fit=crop',   12.00, 0, 1, 'Rolls'),
('m303', 'r3', 'Dragon Roll',            'Eel, avocado, cucumber, unagi glaze.',                                    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&h=600&fit=crop',     18.00, 0, 0, 'Rolls'),
('m304', 'r3', 'Edamame',                'Steamed soybeans with sea salt.',                                         'https://images.unsplash.com/photo-1564834361894-4e430b0ebd5b?w=600&h=600&fit=crop',    6.00, 1, 0, 'Starters'),
('m305', 'r3', 'Mochi Ice Cream',        'Assorted mochi (3 pieces).',                                              'https://images.unsplash.com/photo-1511381939415-e44015466834?w=600&h=600&fit=crop',    7.50, 1, 0, 'Desserts'),

('m401', 'r4', 'Pad Thai',               'Rice noodles, tofu, egg, tamarind, peanuts.',                             'https://images.unsplash.com/photo-1559314809-0d155014e29e?w=600&h=600&fit=crop',     13.50, 0, 1, 'Mains'),
('m402', 'r4', 'Green Curry',            'Coconut green curry with chicken and Thai basil.',                        'https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=600&h=600&fit=crop',   14.50, 0, 1, 'Mains'),
('m403', 'r4', 'Tom Yum Soup',           'Hot and sour soup with shrimp and lemongrass.',                           'https://images.unsplash.com/photo-1547592180-85f173990554?w=600&h=600&fit=crop',      9.50, 0, 0, 'Soups'),
('m404', 'r4', 'Mango Sticky Rice',      'Sweet sticky rice with fresh mango and coconut cream.',                   'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&h=600&fit=crop',    7.50, 1, 0, 'Desserts'),

('m501', 'r5', 'Tacos al Pastor (3pc)',  'Marinated pork, pineapple, cilantro, onion on corn tortillas.',           'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=600&h=600&fit=crop',   11.00, 0, 1, 'Tacos'),
('m502', 'r5', 'Chicken Burrito',        'Grilled chicken, rice, beans, salsa, cheese, guacamole.',                 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=600&h=600&fit=crop',   12.50, 0, 1, 'Burritos'),
('m503', 'r5', 'Veggie Quesadilla',      'Flour tortilla, cheese, peppers, onions, mushrooms.',                     'https://images.unsplash.com/photo-1618040996337-11e2c92b2d4e?w=600&h=600&fit=crop',    9.50, 1, 0, 'Mains'),
('m504', 'r5', 'Chips & Guac',           'House-made tortilla chips with fresh guacamole.',                         'https://images.unsplash.com/photo-1600335895229-6e75511892c8?w=600&h=600&fit=crop',    6.50, 1, 0, 'Sides'),

('m601', 'r6', 'Double Scoop',           'Two scoops of your favorite flavor in a waffle cone.',                    'https://images.unsplash.com/photo-1501443762994-82bd5dace89a?w=600&h=600&fit=crop',    6.50, 1, 1, 'Ice Cream'),
('m602', 'r6', 'Sundae Supreme',         'Three scoops, hot fudge, whipped cream, cherry.',                         'https://images.unsplash.com/photo-1563805042-7684c019e1cb?w=600&h=600&fit=crop',      8.50, 1, 0, 'Sundaes'),
('m603', 'r6', 'Milkshake',              'Thick hand-spun milkshake.',                                              'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=600&h=600&fit=crop',    5.50, 1, 0, 'Drinks'),

('m701', 'r7', 'Cappuccino',             'Espresso with velvety steamed milk foam.',                                'https://images.unsplash.com/photo-1534778101976-62847782c213?w=600&h=600&fit=crop',    4.50, 1, 1, 'Coffee'),
('m702', 'r7', 'Cold Brew',              'Slow-steeped 18-hour cold brew.',                                         'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=600&h=600&fit=crop',    5.00, 1, 1, 'Coffee'),
('m703', 'r7', 'Avocado Toast',          'Sourdough, smashed avocado, chili flakes, lemon.',                        'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=600&h=600&fit=crop',    8.50, 1, 1, 'Food'),
('m704', 'r7', 'Butter Croissant',       'Classic flaky butter croissant.',                                         'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=600&h=600&fit=crop',      4.00, 1, 0, 'Bakery'),

('m801', 'r8', 'Kung Pao Chicken',       'Stir-fried chicken, peanuts, chili, scallions.',                          'https://images.unsplash.com/photo-1525755662778-989d0524087e?w=600&h=600&fit=crop',   13.00, 0, 1, 'Mains'),
('m802', 'r8', 'Vegetable Dumplings',    'Steamed dumplings with cabbage and mushrooms.',                           'https://images.unsplash.com/photo-1496116218417-1a781b1c416c?w=600&h=600&fit=crop',    8.50, 1, 0, 'Starters'),

('m901', 'r9', 'NY Cheese Slice',        'Classic NY cheese slice.',                                                'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&h=600&fit=crop',    3.50, 1, 1, 'Slices'),
('m902', 'r9', 'Garlic Knots (6pc)',     'Garlic knots with parmesan and parsley.',                                 'https://images.unsplash.com/photo-1619985632461-f33748ef8d3d?w=600&h=600&fit=crop',    5.50, 1, 0, 'Sides'),

('m1001', 'r10', 'Barn Burger',          'Grass-fed beef, cheddar, lettuce, tomato, house sauce.',                  'https://images.unsplash.com/photo-1586190848861-99aa4a171e90?w=600&h=600&fit=crop',   11.50, 0, 1, 'Burgers'),
('m1002', 'r10', 'Loaded Fries',         'Fries, cheese, bacon, scallions, ranch.',                                 'https://images.unsplash.com/photo-1630384060421-cb20d0e0649d?w=600&h=600&fit=crop',    7.50, 0, 1, 'Sides');
