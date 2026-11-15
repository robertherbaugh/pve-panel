---
title: Branding
sidebar_position: 4
---

Use **Admin → Settings → Branding** to change the panel name, logo and Windows/Linux icons. The panel stores settings and image bytes in its database. Database backups include the branding.

The saved name applies to both portals, sign-in pages, browser titles and email content. New authenticator and passkey enrollments use that name. Existing authenticator entries keep their previous label. SMTP sender names remain separate email settings.

## Upload images

Choose **Upload logo**, **Upload windows icon** or **Upload linux icon**. Uploads apply immediately. Other open pages show the new branding after a reload. A logo also replaces the browser tab and home screen icons. Remove an upload to restore the built-in artwork.

Use PNG, JPEG, WebP or SVG, up to **1 MiB per image**. Raster images cannot exceed 8192 pixels per side or 16 megapixels. SVG files must contain valid XML without scripts, event handlers, document types or external image references.

## Upgrade existing branding

The first upgrade imports `PANEL_NAME` and fixed image files from `BRANDING_DIR`. The default folder is `data/branding/` beside the database. The accepted file names are `logo.*`, `os-windows.*` and `os-linux.*`. Imported images must meet the upload limits. The panel logs a warning for an image it cannot import.

The import runs once. Later ENV or file changes do not overwrite database settings. Removed images stay removed after restarts. Verify the import before removing an old branding mount.

## Color scheme

**Settings → Appearance** sets the color scheme for **everyone**: the admin interface, the
customer portal, both sign-in pages and the emails the panel sends.

![The five color schemes, and Orchid in dark mode](/color-schemes.png)

| Scheme | Look |
|---|---|
| **Harbor** (default) | signal blue on slate — the original look |
| **Forest** | calm green on deep pine |
| **Ember** | warm orange on dark brown |
| **Orchid** | violet on aubergine |
| **Graphite** | neutral graphite with teal |

![Appearance settings](/appearance-settings.png)

- Click a scheme to **preview** it on your admin page; **Save for everyone** applies it.
  Open pages pick it up when they reload.
- Every scheme has a **light and a dark variant**; the panel follows each device's light/dark
  setting.
- All text reaches at least **4.5:1 contrast** (WCAG AA; 3:1 for large text) in every scheme
  and mode. This is **measured on the rendered pages** by an automated browser test — every
  visible text, including form fields and placeholders, on the customer and admin pages, in
  all five schemes, light and dark — so a scheme can't ship with unreadable text.
- Charts use two clearly different colors in every scheme (e.g. green and amber in *Forest*).
- Status colors — green *running*, orange warnings, red for dangerous actions — are the same in
  every scheme, so they always mean the same thing.
- Users can't choose their own scheme (yet); the setting applies to everyone.
