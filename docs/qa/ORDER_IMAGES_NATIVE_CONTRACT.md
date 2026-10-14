# Native order-image contract

Read-only audit of `mini_rs_erp` at `fd59167ca005d522a8fb102e18ff4c80a380807e` and `accord_mobile_v2` at `bc96f1ce492c3e1708294aa9acb23e6a5e5e63ed`. Existing mobile working changes were inspected as references and preserved. No backend/mobile changes or native tests were made.

| Surface | Existing GET / native authority | Permission and image behavior |
| --- | --- | --- |
| Open orders, maps, apparatus queue | `/v1/mobile/admin/production-maps/order-image/view?order_id=<raw map ID>&variant=thumb-v1` | Capability OR: `admin.access`, `production.map.manage`, `apparatus.queue.read`, `raw_material.assign`, `qolip.manage`, `preparation.access`. Queue-manage alone does not grant image read. Native resolves the map's current image link, or a conservative legacy archive lookup. `image_id` is only a client freshness hint, never authority. |
| Completed / closed history | Same production endpoint; `order_id` | Completed row composite `[order_id, apparatus]` and other history row IDs must not become image IDs. Images reflect the current source link, not a historical pixel snapshot. Native history list permissions/scoping remain distinct from image permissions. |
| Owner templates | `/v1/mobile/calculate/orders/image/view?id=<image_id>&variant=thumb-v1` | `admin.access` OR `production.map.manage`; native owner scope, with existing actual-admin Telegram-owner fallback. ASCII image ID, maximum 64 characters. This route is never a fallback for production orders. |
| Pending orders | `/v1/mobile/admin/pending-orders/image?id=<outer pending ID>` | Same two-capability OR. Stored pending bytes, full image only, private/no-cache. Variant is ignored; there is no native thumbnail/ETag route. The web therefore reserves a neutral box and fetches full bytes only on an explicit viewer action. It does not claim a network thumbnail optimization here. |

For production and owner templates, exact `thumb-v1` yields WebP with a maximum 256px dimension and no upscaling. Omitting variant returns stored full bytes. The server uses `private, max-age=0, must-revalidate`, `Vary: Authorization`, SHA256 ETag and conditional 304. Native authorization and current map resolution precede cache access. The web preserves these metadata, uses Bearer headers through its existing session client, and accepts explicit 200 image bytes; it supplies no bearer tokens in asset URLs, no external image URLs, and no immutable-cache claim.

Missing-photo 404 is distinct from missing order, ambiguous legacy lookup, bare unavailable-route 404 and 401/403 denial. Native thumbnail decode errors are not proof that an order has no photo. Browser decoding still validates the returned raster, and an oversized or broken thumbnail does not trigger an automatic full download.

Known native limits remain explicit:

- The production handler manually parses raw URI query fields without percent decoding. Legacy IDs requiring escaping (spaces, Unicode or reserved characters) may fail native lookup. The web preserves the exact ID through query encoding and reports the read failure; it does not guess another authority.
- Source cache is keyed by owner/source-image-ID/variant with a 900-second TTL, 512 entries and 64 MiB. Replacing pixels under the same image ID can remain stale for 15 minutes. A changed map link is resolved on every request; explicit list refresh revalidates current nearby image reads.
- History images are current-link observations, not immutable historical pictures.
- Pending orders have no server thumbnail route. Frontend full-image downsampling would still download the full source, so automatic row thumbnails are deliberately absent for this surface.
- The web has explicit client bounds: 1 MiB thumbnail response, 8 MiB full response, JPEG/PNG/WebP raster types, three concurrently active near-visible thumbnail reads, and short-lived session-scoped thumbnail queries. Large legacy full files or unsupported raster types produce a visible read error; native files are not rewritten.

Sources: backend `src/http/handlers/admin/production_maps/order_image.rs`, `src/http/handlers/calculate.rs`, `src/http/handlers/calculate_image.rs`, `src/core/order_image_cache.rs`, `src/http/handlers/admin/pending_orders.rs`, `src/http/handlers/admin/production_maps/completion.rs`; mobile `lib/src/core/api/admin/mobile_api_order_images.dart`, `mobile_api_pending_orders.dart`, `features/admin/presentation/admin_production_map_orders_order_image_thumb.dart`, `features/admin/presentation/widgets/admin_order_image_thumb.dart` and `core/widgets/display/order_image_provider.dart`.
