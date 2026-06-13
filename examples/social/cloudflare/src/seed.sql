-- Users
INSERT INTO users (id, username, display_name, avatar_url, bio, posts_count, followers_count, following_count) VALUES
('u1', 'alice_explores', 'Alice Chen', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&h=150&fit=crop', 'Photographer & world traveler. Currently in Tokyo.', 42, 12400, 340),
('u2', 'bob_brews', 'Bob Martinez', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop', 'Coffee roaster. Latte art enthusiast.', 28, 8700, 220),
('u3', 'charlie_eats', 'Charlie Kim', 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&h=150&fit=crop', 'NYC food blogger. Always hungry.', 156, 34200, 180),
('u4', 'diana_designs', 'Diana Okafor', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop', 'UI/UX Designer at @figma. Dog mom.', 67, 56300, 410),
('u5', 'eve_runs', 'Eve Johansson', 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&h=150&fit=crop', 'Marathon runner. Mountain lover.', 91, 21500, 305);

-- Posts (using real Unsplash photo IDs)
INSERT INTO posts (id, user_id, image_url, caption, location, likes_count, comments_count, created_at) VALUES
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
('p30', 'u1', 'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=600&h=600&fit=crop', 'Road trip through Iceland. This country is unreal.', 'Iceland', 8900, 298, datetime('now', '-10 days'));

-- Stories
INSERT INTO stories (id, user_id, image_url, has_unseen, created_at) VALUES
('s1', 'u2', 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=400&h=700&fit=crop', 1, datetime('now', '-1 hour')),
('s2', 'u3', 'https://images.unsplash.com/photo-1476224203421-9ac39bcb3327?w=400&h=700&fit=crop', 1, datetime('now', '-3 hours')),
('s3', 'u4', 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=400&h=700&fit=crop', 1, datetime('now', '-5 hours')),
('s4', 'u5', 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=400&h=700&fit=crop', 0, datetime('now', '-10 hours'));

-- Comments
INSERT INTO comments (id, post_id, user_id, text, created_at) VALUES
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
INSERT INTO likes (post_id, user_id) VALUES
('p2', 'u1'),
('p4', 'u1'),
('p5', 'u1'),
('p1', 'u3'),
('p1', 'u4'),
('p4', 'u2');

-- Saves (alice has saved some posts)
INSERT INTO saves (post_id, user_id) VALUES
('p3', 'u1'),
('p4', 'u1');
