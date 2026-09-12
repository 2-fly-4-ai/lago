-- Enable automatic EPD collection in production only for the recurring Store
-- products proven in the 2026-09-11 full-catalog staging rollout. One-time
-- products are omitted. Existing rows keep their original creation timestamp.
WITH recurring_product_slugs(product_slug) AS (
  VALUES
    ('123movies-downloader'),
    ('bongacams-downloader'),
    ('cam4-video-downloader'),
    ('camscom-video-downloader'),
    ('camsoda-downloader'),
    ('chaturbate-downloader'),
    ('circle-downloader'),
    ('clientclub-downloader'),
    ('czechvideo-downloader'),
    ('dailymotion-downloader'),
    ('dreamcam-video-downloader'),
    ('dreamcam-vr-video-downloader'),
    ('facebook-video-downloader'),
    ('fansly-live-downloader'),
    ('flirt4free-video-downloader'),
    ('gohighlevel-downloader'),
    ('gokollab-downloader'),
    ('justforfans-downloader'),
    ('kajabi-video-downloader'),
    ('loom-video-downloader'),
    ('m3u8-downloader'),
    ('mindvalley-downloader'),
    ('myfreecams-downloader'),
    ('onlyfans-downloader'),
    ('patreon-downloader'),
    ('pinterest-downloader'),
    ('serp-1-app-plan'),
    ('serp-1-app-plus-plan'),
    ('serp-1-app-premium-plan'),
    ('serp-app-plus-plan'),
    ('serp-downloaders-bundle'),
    ('serp-vpn'),
    ('skool-bulk-downloader'),
    ('skool-downloader-tailsgate'),
    ('skool-video-downloader'),
    ('sprout-video-downloader'),
    ('streamate-video-downloader'),
    ('stripchat-video-downloader'),
    ('stripchat-vr-video-downloader'),
    ('tellatv-downloader'),
    ('tiktok-downloader'),
    ('twitter-video-downloader'),
    ('whop-downloader-tailsgate'),
    ('whop-video-downloader'),
    ('wistia-video-downloader'),
    ('xhamsterlive-video-downloader'),
    ('xlovecam-video-downloader'),
    ('youtube-downloader')
)
INSERT INTO easy_pay_direct_product_collection_policies
  (organization_id, product_slug, status, created_at)
SELECT
  organization.id,
  recurring_product_slugs.product_slug,
  'enabled',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM organizations AS organization
CROSS JOIN recurring_product_slugs
WHERE organization.id = 'org-serp-billing'
ON CONFLICT (organization_id, product_slug) DO UPDATE SET status = excluded.status;
