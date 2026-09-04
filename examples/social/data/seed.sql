-- Users
INSERT OR IGNORE INTO users (id, username, display_name, avatar_url, bio, posts_count, followers_count, following_count) VALUES
('u1', 'alice_explores', 'Alice Chen', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&h=150&fit=crop', 'Photographer & world traveler. Currently in Tokyo.', 42, 12400, 340),
('u2', 'bob_brews', 'Bob Martinez', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop', 'Coffee roaster. Latte art enthusiast.', 28, 8700, 220),
('u3', 'charlie_eats', 'Charlie Kim', 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&h=150&fit=crop', 'NYC food blogger. Always hungry.', 156, 34200, 180),
('u4', 'diana_designs', 'Diana Okafor', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop', 'UI/UX Designer at @figma. Dog mom.', 67, 56300, 410),
('u5', 'eve_runs', 'Eve Johansson', 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&h=150&fit=crop', 'Marathon runner. Mountain lover.', 91, 21500, 305),
('u6', 'maya_frames', 'Maya Patel', 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=150&h=150&fit=crop', 'Film photographer chasing warm light and quiet streets.', 18, 6800, 412),
('u7', 'noah_archives', 'Noah Williams', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop', 'Architecture, old books, and cities after rain.', 31, 9200, 287),
('u8', 'sofia_cooks', 'Sofia Rossi', 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&h=150&fit=crop', 'Seasonal cooking from a very small kitchen.', 54, 17400, 198),
('u9', 'lucas_wanders', 'Lucas Moreau', 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&h=150&fit=crop', 'Train windows, mountain trails, no fixed itinerary.', 76, 25900, 536),
('u10', 'zoe_studio', 'Zoe Bennett', 'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?w=150&h=150&fit=crop', 'Ceramics and color experiments from London.', 23, 11300, 329),
('u11', 'theo_cycles', 'Theo Nguyen', 'https://images.unsplash.com/photo-1527980965255-d3b416303d12?w=150&h=150&fit=crop', 'Cyclist, maker, and weekend map collector.', 39, 7900, 611),
('u12', 'amara_reads', 'Amara Johnson', 'https://randomuser.me/api/portraits/women/44.jpg', 'Bookshops, marginalia, and very strong tea.', 1, 4800, 312),
('u13', 'finn_surfs', 'Finn O''Connor', 'https://randomuser.me/api/portraits/men/32.jpg', 'Atlantic swells and early morning forecasts.', 1, 12100, 428),
('u14', 'lina_gardens', 'Lina Haddad', 'https://randomuser.me/api/portraits/women/65.jpg', 'Urban gardener growing more than fits on the balcony.', 1, 7300, 286),
('u15', 'kenji_nights', 'Kenji Sato', 'https://randomuser.me/api/portraits/men/11.jpg', 'Neon streets and Tokyo after the last train.', 1, 19400, 521),
('u16', 'nadia_moves', 'Nadia Petrova', 'https://randomuser.me/api/portraits/women/79.jpg', 'Movement coach. Always learning a new rhythm.', 1, 9800, 344),
('u17', 'mateo_makes', 'Mateo Silva', 'https://randomuser.me/api/portraits/men/52.jpg', 'Furniture maker with a weakness for walnut.', 1, 6100, 233),
('u18', 'priya_patterns', 'Priya Raman', 'https://randomuser.me/api/portraits/women/49.jpg', 'Textile designer collecting patterns everywhere.', 1, 14300, 407),
('u19', 'oliver_sound', 'Oliver Reed', 'https://randomuser.me/api/portraits/men/75.jpg', 'Producer, crate digger, occasional drummer.', 1, 8700, 692),
('u20', 'ines_coast', 'Ines Costa', 'https://randomuser.me/api/portraits/women/32.jpg', 'Marine biologist documenting the Atlantic coast.', 1, 16500, 315),
('u21', 'samir_streets', 'Samir Khan', 'https://randomuser.me/api/portraits/men/43.jpg', 'Street photography and cities on foot.', 1, 22600, 519),
('u22', 'clara_climbs', 'Clara Meyer', 'https://randomuser.me/api/portraits/women/68.jpg', 'Climber, route setter, snack enthusiast.', 1, 11900, 374),
('u23', 'jamal_journals', 'Jamal Brooks', 'https://randomuser.me/api/portraits/men/61.jpg', 'Writer with too many notebooks and not enough shelves.', 1, 5900, 281),
('u24', 'yuna_draws', 'Yuna Park', 'https://randomuser.me/api/portraits/women/26.jpg', 'Illustrator turning everyday moments into color.', 1, 20700, 463),
('u25', 'felix_finds', 'Felix Laurent', 'https://randomuser.me/api/portraits/men/18.jpg', 'Vintage hunter and weekend flea-market guide.', 1, 10400, 732),
('u26', 'aisha_atlas', 'Aisha Mensah', 'https://randomuser.me/api/portraits/women/58.jpg', 'Maps, long train rides, and stories from the road.', 1, 18800, 601),
('u27', 'leo_bakes', 'Leo Romano', 'https://randomuser.me/api/portraits/men/46.jpg', 'Bread baker. Fermentation is the schedule.', 1, 13200, 297),
('u28', 'marta_moments', 'Marta Kowalska', 'https://randomuser.me/api/portraits/women/76.jpg', 'Documentary photographer based in Warsaw.', 1, 15600, 438),
('u29', 'devon_dances', 'Devon Price', 'https://randomuser.me/api/portraits/men/15.jpg', 'Dancer and choreographer building movement in public spaces.', 1, 9100, 355),
('u30', 'hana_crafts', 'Hana Mori', 'https://randomuser.me/api/portraits/women/43.jpg', 'Paper, clay, thread, and patient hands.', 1, 12400, 264);

-- Posts (using real Unsplash photo IDs)
INSERT OR IGNORE INTO posts (id, user_id, image_url, caption, location, likes_count, comments_count, created_at) VALUES
('p1', 'u2', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=600&h=600&fit=crop', 'Morning pour-over ritual. The beans are from a small farm in Guatemala.', 'Brooklyn, NY', 1420, 42, datetime('now', '-2 hours')),
('p2', 'u3', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&h=600&fit=crop', 'Found the best Neapolitan pizza outside of Naples. The crust is perfection.', 'Manhattan, NY', 2890, 87, datetime('now', '-4 hours')),
('p3', 'u4', 'https://images.unsplash.com/photo-1602576666092-bf6447a729fc?w=600&h=600&fit=crop', 'New design system coming together. Every pixel matters.', NULL, 5230, 134, datetime('now', '-6 hours')),
('p4', 'u1', 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=600&h=600&fit=crop', 'Golden hour in Kyoto. This city never stops surprising me.', 'Kyoto, Japan', 8740, 256, datetime('now', '-8 hours')),
('p5', 'u5', 'https://images.unsplash.com/photo-1551698618-1dfe5d97d256?w=600&h=600&fit=crop', 'Summit day! 14 hours of climbing but so worth it.', 'Mt. Rainier, WA', 4320, 98, datetime('now', '-12 hours')),
('p6', 'u2', 'https://images.unsplash.com/photo-1511920170033-f8396924c348?w=600&h=600&fit=crop', 'Experimenting with cold brew ratios. This one is 1:8 for 18 hours.', 'Home Lab', 980, 23, datetime('now', '-1 day')),
('p7', 'u3', 'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=600&h=600&fit=crop', 'When the tasting menu hits different. 12 courses of pure joy.', 'Le Bernardin, NYC', 3450, 67, datetime('now', '-1 day')),
('p8', 'u4', 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600&h=600&fit=crop', 'Playing with generative art for the new brand identity.', NULL, 7120, 201, datetime('now', '-2 days')),
('p9', 'u5', 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&h=600&fit=crop', 'Above the clouds at sunrise. Worth every step.', 'Swiss Alps', 6210, 178, datetime('now', '-2 days')),
('p10', 'u1', 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&h=600&fit=crop', 'Street food in Bangkok. This pad thai changed my life.', 'Bangkok, Thailand', 3890, 92, datetime('now', '-3 days')),
('p11', 'u2', 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=600&h=600&fit=crop', 'Found this hidden gem of a cafe. The latte art is unreal.', 'Portland, OR', 2150, 56, datetime('now', '-3 days')),
('p12', 'u3', 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=600&h=600&fit=crop', 'Farm to table done right. Every ingredient from within 50 miles.', 'Napa Valley, CA', 4670, 123, datetime('now', '-3 days')),
('p13', 'u4', 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=600&h=600&fit=crop', 'New typeface exploration. Geometric meets humanist.', NULL, 3340, 89, datetime('now', '-4 days')),
('p14', 'u5', 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&h=600&fit=crop', 'The Dolomites at golden hour. Nature is the best designer.', 'Dolomites, Italy', 9120, 312, datetime('now', '-4 days')),
('p15', 'u1', 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&h=600&fit=crop', 'Paris never gets old. The light here is something else.', 'Paris, France', 7560, 234, datetime('now', '-4 days')),
('p16', 'u2', 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=600&h=600&fit=crop', 'Single origin from Ethiopia. Bright, fruity, unforgettable.', 'Home Lab', 1890, 45, datetime('now', '-5 days')),
('p17', 'u3', 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=600&h=600&fit=crop', 'Homemade ramen from scratch. 18 hour broth.', 'Home Kitchen', 5430, 156, datetime('now', '-5 days')),
('p18', 'u4', 'https://images.unsplash.com/photo-1502691876148-a84978e59af8?w=600&h=600&fit=crop', 'Color palette study for the new app. Warm earth tones.', NULL, 4210, 98, datetime('now', '-5 days')),
('p19', 'u5', 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=600&h=600&fit=crop', 'Night sky from 12,000 feet. The Milky Way was incredible.', 'Mt. Hood, OR', 8320, 267, datetime('now', '-6 days')),
('p20', 'u1', 'https://images.unsplash.com/photo-1745159397026-ccbeeb239473?w=600&h=600&fit=crop', 'Cherry blossoms in full bloom. Tokyo in spring is magical.', 'Tokyo, Japan', 6780, 198, datetime('now', '-6 days')),
('p21', 'u2', 'https://images.unsplash.com/photo-1442512595331-e89e73853f31?w=600&h=600&fit=crop', 'Aeropress championship prep. Dialing in the perfect recipe.', 'Competition Day', 2340, 67, datetime('now', '-6 days')),
('p22', 'u3', 'https://images.unsplash.com/photo-1482049016688-2d3e1b311543?w=600&h=600&fit=crop', 'Fresh sashimi at Tsukiji. This is what perfection looks like.', 'Tokyo, Japan', 6120, 189, datetime('now', '-7 days')),
('p23', 'u4', 'https://images.unsplash.com/photo-1545235617-7a424c1a60cc?w=600&h=600&fit=crop', 'Motion design explorations. Smooth transitions make the difference.', NULL, 5670, 145, datetime('now', '-7 days')),
('p24', 'u5', 'https://images.unsplash.com/photo-1454496522488-7a8e488e8606?w=600&h=600&fit=crop', 'Base camp views. Tomorrow we go for the summit.', 'Himalayas, Nepal', 7890, 234, datetime('now', '-7 days')),
('p25', 'u1', 'https://images.unsplash.com/photo-1512100356356-de1b84283e18?w=600&h=600&fit=crop', 'Sunset over Santorini. Every angle is a postcard.', 'Santorini, Greece', 9450, 345, datetime('now', '-8 days')),
('p26', 'u2', 'https://images.unsplash.com/photo-1498804103079-a6351b050096?w=600&h=600&fit=crop', 'Cupping session with beans from 6 different origins.', 'Brooklyn, NY', 1670, 38, datetime('now', '-8 days')),
('p27', 'u3', 'https://images.unsplash.com/photo-1476224203421-9ac39bcb3327?w=600&h=600&fit=crop', 'Sunday brunch goals. Eggs benedict with house-cured salmon.', 'West Village, NYC', 4890, 134, datetime('now', '-8 days')),
('p28', 'u4', 'https://images.unsplash.com/photo-1558655146-d09347e92766?w=600&h=600&fit=crop', 'Icon set complete. 200 icons, all hand-crafted.', NULL, 8230, 267, datetime('now', '-9 days')),
('p29', 'u5', 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=600&h=600&fit=crop', 'Morning mist in the valley. Nature therapy at its finest.', 'Yosemite, CA', 5670, 156, datetime('now', '-9 days')),
('p30', 'u1', 'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=600&h=600&fit=crop', 'Road trip through Iceland. This country is unreal.', 'Iceland', 8900, 298, datetime('now', '-10 days')),
('p31', 'u6', 'https://images.unsplash.com/photo-1511818966892-d7d671e672a2?w=600&h=600&fit=crop', 'Blue hour, empty sidewalks, one roll of film.', 'Lisbon, Portugal', 1820, 37, datetime('now', '-30 minutes')),
('p32', 'u7', 'https://images.unsplash.com/photo-1518005020951-eccb494ad742?w=600&h=600&fit=crop', 'Concrete can feel soft when the light is right.', 'Copenhagen, Denmark', 2640, 51, datetime('now', '-75 minutes')),
('p33', 'u8', 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=600&h=600&fit=crop', 'Pasta, lemon, herbs, and absolutely no leftovers.', 'Florence, Italy', 3980, 96, datetime('now', '-3 hours')),
('p34', 'u9', 'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?w=600&h=600&fit=crop', 'Woke up above the clouds and stayed for the silence.', 'Chamonix, France', 5710, 142, datetime('now', '-5 hours')),
('p35', 'u10', 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=600&h=600&fit=crop', 'Fresh from the kiln. The glaze did exactly what it wanted.', 'London, UK', 2210, 44, datetime('now', '-7 hours')),
('p36', 'u11', 'https://images.unsplash.com/photo-1529422643029-d4585747aaf2?w=600&h=600&fit=crop', 'The long way home is usually the better route.', 'Amsterdam, Netherlands', 1460, 29, datetime('now', '-9 hours')),
('p37', 'u12', 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=600&h=600&fit=crop', 'A quiet corner and a book I did not mean to finish today.', 'Edinburgh, UK', 1380, 31, datetime('now', '-20 minutes')),
('p38', 'u13', 'https://images.unsplash.com/photo-1502680390469-be75c86b636f?w=600&h=600&fit=crop', 'Clean lines before breakfast. Worth the cold paddle out.', 'Bundoran, Ireland', 2840, 58, datetime('now', '-45 minutes')),
('p39', 'u14', 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=600&h=600&fit=crop', 'The tomatoes finally understood the assignment.', 'Beirut, Lebanon', 1760, 42, datetime('now', '-70 minutes')),
('p40', 'u15', 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=600&h=600&fit=crop', 'Rain turns every sign into two signs.', 'Shinjuku, Tokyo', 4920, 107, datetime('now', '-2 hours')),
('p41', 'u16', 'https://images.unsplash.com/photo-1538805060514-97d9cc17730c?w=600&h=600&fit=crop', 'Finding the beat before the room wakes up.', 'Berlin, Germany', 2310, 49, datetime('now', '-3 hours')),
('p42', 'u17', 'https://images.unsplash.com/photo-1452860606245-08befc0ff44b?w=600&h=600&fit=crop', 'One table, four joints, no shortcuts.', 'Porto, Portugal', 1670, 36, datetime('now', '-4 hours')),
('p43', 'u18', 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=600&h=600&fit=crop', 'Color studies from the market this morning.', 'Jaipur, India', 3560, 73, datetime('now', '-5 hours')),
('p44', 'u19', 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=600&fit=crop', 'That moment when the whole room lands on the same note.', 'Manchester, UK', 3180, 84, datetime('now', '-6 hours')),
('p45', 'u20', 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&h=600&fit=crop', 'Field notes from a very blue office.', 'Azores, Portugal', 4270, 96, datetime('now', '-7 hours')),
('p46', 'u21', 'https://images.unsplash.com/photo-1519501025264-65ba15a82390?w=600&h=600&fit=crop', 'The city makes its own geometry from above.', 'Barcelona, Spain', 5120, 119, datetime('now', '-8 hours')),
('p47', 'u22', 'https://images.unsplash.com/photo-1522163182402-834f871fd851?w=600&h=600&fit=crop', 'Trust the feet, then trust them again.', 'El Chaltén, Argentina', 3890, 88, datetime('now', '-10 hours')),
('p48', 'u23', 'https://images.unsplash.com/photo-1455390582262-044cdead277a?w=600&h=600&fit=crop', 'Draft three is where the honest sentence showed up.', 'Chicago, IL', 1210, 27, datetime('now', '-12 hours')),
('p49', 'u24', 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=600&h=600&fit=crop', 'Today started in pencil and ended in orange.', 'Seoul, South Korea', 4680, 103, datetime('now', '-14 hours')),
('p50', 'u25', 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?w=600&h=600&fit=crop', 'The jacket found me first.', 'Paris, France', 2430, 61, datetime('now', '-16 hours')),
('p51', 'u26', 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=600&h=600&fit=crop', 'No direct route, no complaints.', 'Marrakesh, Morocco', 5370, 126, datetime('now', '-18 hours')),
('p52', 'u27', 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=600&h=600&fit=crop', 'The crust sang when it cooled.', 'Bologna, Italy', 3310, 79, datetime('now', '-20 hours')),
('p53', 'u28', 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=600&h=600&fit=crop', 'The best frame happened between the planned ones.', 'Warsaw, Poland', 2790, 64, datetime('now', '-22 hours')),
('p54', 'u29', 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=600&h=600&fit=crop', 'Rehearsal escaped into the street.', 'Los Angeles, CA', 4020, 91, datetime('now', '-1 day')),
('p55', 'u30', 'https://images.unsplash.com/photo-1453306458620-5bbef13a5bca?w=600&h=600&fit=crop', 'Small tools, slow afternoon, happy hands.', 'Kanazawa, Japan', 2140, 47, datetime('now', '-1 day'));

-- Stories
INSERT OR IGNORE INTO stories (id, user_id, image_url, has_unseen, created_at) VALUES
('s1', 'u2', 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=400&h=700&fit=crop', 1, datetime('now', '-1 hour')),
('s2', 'u3', 'https://images.unsplash.com/photo-1476224203421-9ac39bcb3327?w=400&h=700&fit=crop', 1, datetime('now', '-3 hours')),
('s3', 'u4', 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=400&h=700&fit=crop', 1, datetime('now', '-5 hours')),
('s4', 'u5', 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=400&h=700&fit=crop', 0, datetime('now', '-10 hours')),
('s5', 'u6', 'https://images.unsplash.com/photo-1511818966892-d7d671e672a2?w=400&h=700&fit=crop', 1, datetime('now', '-35 minutes')),
('s6', 'u7', 'https://images.unsplash.com/photo-1518005020951-eccb494ad742?w=400&h=700&fit=crop', 1, datetime('now', '-80 minutes')),
('s7', 'u8', 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=400&h=700&fit=crop', 1, datetime('now', '-2 hours')),
('s8', 'u9', 'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?w=400&h=700&fit=crop', 1, datetime('now', '-4 hours')),
('s9', 'u10', 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=400&h=700&fit=crop', 0, datetime('now', '-7 hours')),
('s10', 'u11', 'https://images.unsplash.com/photo-1529422643029-d4585747aaf2?w=400&h=700&fit=crop', 1, datetime('now', '-9 hours')),
('s11', 'u12', 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=400&h=700&fit=crop', 1, datetime('now', '-25 minutes')),
('s12', 'u13', 'https://images.unsplash.com/photo-1502680390469-be75c86b636f?w=400&h=700&fit=crop', 1, datetime('now', '-50 minutes')),
('s13', 'u14', 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=400&h=700&fit=crop', 1, datetime('now', '-75 minutes')),
('s14', 'u15', 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=400&h=700&fit=crop', 1, datetime('now', '-2 hours')),
('s15', 'u16', 'https://images.unsplash.com/photo-1538805060514-97d9cc17730c?w=400&h=700&fit=crop', 0, datetime('now', '-3 hours')),
('s16', 'u17', 'https://images.unsplash.com/photo-1452860606245-08befc0ff44b?w=400&h=700&fit=crop', 1, datetime('now', '-4 hours')),
('s17', 'u18', 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=400&h=700&fit=crop', 1, datetime('now', '-5 hours')),
('s18', 'u19', 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400&h=700&fit=crop', 1, datetime('now', '-6 hours')),
('s19', 'u20', 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=400&h=700&fit=crop', 0, datetime('now', '-7 hours')),
('s20', 'u21', 'https://images.unsplash.com/photo-1519501025264-65ba15a82390?w=400&h=700&fit=crop', 1, datetime('now', '-8 hours')),
('s21', 'u22', 'https://images.unsplash.com/photo-1522163182402-834f871fd851?w=400&h=700&fit=crop', 1, datetime('now', '-9 hours')),
('s22', 'u23', 'https://images.unsplash.com/photo-1455390582262-044cdead277a?w=400&h=700&fit=crop', 1, datetime('now', '-10 hours')),
('s23', 'u24', 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=400&h=700&fit=crop', 1, datetime('now', '-11 hours')),
('s24', 'u25', 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?w=400&h=700&fit=crop', 0, datetime('now', '-12 hours')),
('s25', 'u26', 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=400&h=700&fit=crop', 1, datetime('now', '-13 hours')),
('s26', 'u27', 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&h=700&fit=crop', 1, datetime('now', '-14 hours')),
('s27', 'u28', 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=400&h=700&fit=crop', 1, datetime('now', '-15 hours')),
('s28', 'u29', 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=400&h=700&fit=crop', 1, datetime('now', '-16 hours')),
('s29', 'u30', 'https://images.unsplash.com/photo-1453306458620-5bbef13a5bca?w=400&h=700&fit=crop', 1, datetime('now', '-17 hours'));

-- Comments
INSERT OR IGNORE INTO comments (id, post_id, user_id, text, created_at) VALUES
('c1', 'p1', 'u1', 'That looks incredible! What grinder are you using?', datetime('now', '-1 hour')),
('c2', 'p1', 'u3', 'Need to visit your shop soon!', datetime('now', '-90 minutes')),
('c3', 'p2', 'u1', 'Adding this to my list immediately', datetime('now', '-3 hours')),
('c4', 'p2', 'u4', 'We went last week, can confirm it is amazing', datetime('now', '-3 hours')),
('c5', 'p2', 'u5', 'The margherita is unreal', datetime('now', '-2 hours')),
('c6', 'p4', 'u2', 'Stunning shot! What camera?', datetime('now', '-7 hours')),
('c7', 'p4', 'u3', 'Japan is on my bucket list', datetime('now', '-6 hours')),
('c8', 'p4', 'u4', 'The colors in this are magical', datetime('now', '-5 hours')),
('c9', 'p5', 'u1', 'Beast mode! How was the altitude?', datetime('now', '-11 hours')),
('c10', 'p5', 'u2', 'Congrats on the summit!', datetime('now', '-10 hours'));

-- Likes (alice has liked some posts)
INSERT OR IGNORE INTO likes (post_id, user_id) VALUES
('p2', 'u1'),
('p4', 'u1'),
('p5', 'u1'),
('p1', 'u3'),
('p1', 'u4'),
('p4', 'u2');

-- Saves (alice has saved some posts)
INSERT OR IGNORE INTO saves (post_id, user_id) VALUES
('p3', 'u1'),
('p4', 'u1');

-- Direct message conversations (alice + everyone)
INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES
('u1', 'u2'),
('u1', 'u4'),
('u1', 'u8');

INSERT OR IGNORE INTO conversations (id, user_a, user_b, created_at) VALUES
('dm1', 'u1', 'u2', datetime('now', '-3 days')),
('dm2', 'u1', 'u3', datetime('now', '-2 days')),
('dm3', 'u1', 'u4', datetime('now', '-5 days')),
('dm4', 'u1', 'u5', datetime('now', '-4 days')),
('dm5', 'u1', 'u8', datetime('now', '-1 day')),
('dm6', 'u1', 'u9', datetime('now', '-6 hours'));

INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, text, is_read, created_at) VALUES
-- alice <-> bob (coffee)
('msg1',  'dm1', 'u1', 'Hey Bob! Still up for that cupping session?', 1, datetime('now', '-1 day')),
('msg2',  'dm1', 'u2', 'Absolutely, come by the roastery Saturday', 1, datetime('now', '-1 day')),
('msg3',  'dm1', 'u1', 'Perfect, I''ll bring the Kyoto beans I told you about', 1, datetime('now', '-5 hours')),
('msg4',  'dm1', 'u2', 'That coffee spot was incredible!', 0, datetime('now', '-2 hours')),
-- alice <-> charlie (food)
('msg5',  'dm2', 'u3', 'You have to try that new ramen place', 1, datetime('now', '-1 day')),
('msg6',  'dm2', 'u1', 'The one in the East Village? Heard the broth is amazing', 1, datetime('now', '-1 day')),
('msg7',  'dm2', 'u3', 'See you at the food festival 🍕', 0, datetime('now', '-5 hours')),
-- alice <-> diana (design)
('msg8',  'dm3', 'u1', 'The new icon set looks fantastic!', 1, datetime('now', '-2 days')),
('msg9',  'dm3', 'u4', 'Thanks! 200 icons nearly broke me 😅', 1, datetime('now', '-2 days')),
('msg10', 'dm3', 'u4', 'Love the new designs!', 1, datetime('now', '-1 day')),
-- alice <-> eve (hiking)
('msg11', 'dm4', 'u5', 'Rainier was brutal but amazing', 1, datetime('now', '-3 days')),
('msg12', 'dm4', 'u1', 'Your summit photos are stunning!', 1, datetime('now', '-3 days')),
('msg13', 'dm4', 'u5', 'Want to join the next hike?', 1, datetime('now', '-2 days')),
('msg14', 'dm5', 'u8', 'I saved you a seat at the supper club', 0, datetime('now', '-8 hours')),
('msg15', 'dm6', 'u1', 'That ridge photo is unreal', 1, datetime('now', '-4 hours')),
('msg16', 'dm6', 'u9', 'Next time you are coming with us!', 0, datetime('now', '-90 minutes'));
