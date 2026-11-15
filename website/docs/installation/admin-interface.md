---
title: Reaching the admin interface
sidebar_position: 6
---

By default the admin server listens on `127.0.0.1:3001` only. From your own
machine, open an SSH tunnel and browse to http://localhost:3001:

```bash
ssh -L 3001:127.0.0.1:3001 you@panel-host
```

To reach it over a VPN or internal network instead, set `ADMIN_HOST` to that
interface's address (or `0.0.0.0`) and restrict the port with a firewall. The
panel logs a warning at startup when the admin server isn't local-only.

## Sections and tables

Use the sidebar to open an admin page, then the horizontal tabs to choose a
section. For example, Compute has sections for VM sizes, storage classes,
high availability, private access, VM adoption, customer offerings, capacity,
and operations. Switching sections keeps unsaved form values. Arrow keys,
Home, and End move between tabs.

Admin tables, including customer member dialogs, provide:

- Search across the inventory and filters for individual columns.
- Ascending or descending sorting from the column headings.
- A choice of 10, 25, 50, or 100 rows per page (25 by default).
- First, previous, next, and last page buttons, plus a page number field.

Searches and filters apply before pagination. Paging, filtering, and sorting
retain unsaved values in editable tables. Each table remembers its controls
while you navigate within the admin interface; reloading the browser resets them.
Activity, compute operations, and backup reservations query the full database
history, including records older than the latest 200 entries.
