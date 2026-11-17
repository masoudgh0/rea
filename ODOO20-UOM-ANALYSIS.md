# Odoo 20 — Unit of Measure (UOM) System: Deep Analysis

**Evidence base**: `odoo/odoo` branch `20.0`, commit `9d233dca4156d58ca573e9cdc3b32327c97aa282`
(2026-11-15), analyzed from source on 2026-11-16. All claims below cite `path:line`.
The custom `masoudgh0/Odoo-enterprise` repository was inaccessible to the sandbox's GitHub
integration (HTTP 403, private repo outside the app's grant); this analysis covers the
official Odoo 20 community source, where the entire UOM core lives (`addons/uom`).
Enterprise/stock-barcode/mrp addons only *extend* this system.

---

## 1. The big picture — a tree, not categories

Odoo 20 **removed the `uom.category` model entirely**. Units no longer belong to flat
categories ("Weight", "Unit", "Working Time"); instead, `uom.uom` records form a
**parent/child tree of reference units** (`addons/uom/models/uom_uom.py:20-21`):

```python
_parent_name = 'relative_uom_id'
_parent_store = True          # parent_path materialized-path index
```

- Every unit points at a **Reference Unit** (`relative_uom_id`) and declares how many of
  that reference one of itself "Contains" (`relative_factor`).
- Each tree's **root** is the absolute reference of its dimension and must have
  `relative_factor == 1.0` (`_check_factor`, `uom_uom.py:90-93`).
- The stored, recursive `factor` ("Absolute Quantity") is the unit's absolute ratio vs the
  tree root: `factor = relative_factor × parent.factor` (`_compute_factor`, `uom_uom.py:62-67`).

Dimension membership is therefore *structural*: `mm → cm → m → km` and `in → ft → yd → mile`
are **one single length tree** (imperial units are grafted onto metric parents, e.g.
`in = 2.54 × cm`, `uom_data.xml`). Two units are convertible iff they share a tree root.

## 2. Data model (`uom.uom`, 220 lines total)

| Field | Type | Meaning | Source |
|---|---|---|---|
| `name` | Char, translate | Display name ("Units", "kg") | `uom_uom.py:35` |
| `relative_uom_id` | Many2one→`uom.uom`, `ondelete='cascade'` | Parent/reference unit | `uom_uom.py:40` |
| `relative_factor` | Float, `digits=0` (unlimited NUMERIC), required | "Contains": how many parent units one of this equals | `uom_uom.py:36-38` |
| `factor` | Float, computed+stored, recursive | Absolute ratio vs tree root | `uom_uom.py:42` |
| `parent_path` | Char, indexed | Materialized path for subtree queries | `uom_uom.py:43` |
| `related_uom_ids` | One2many via `relative_uom_id` | Children | `uom_uom.py:41` |
| `sequence` | Integer, computed | Sort key ≈ `min(int(relative_factor*100), 1000)` | `uom_uom.py:34, 57-63` |
| `active` | Boolean | Archive instead of delete | `uom_uom.py:39` |

Constraints:
- DB `CHECK (relative_factor != 0)` (`uom_uom.py:45-48`).
- `_check_factor`: a rootless unit must have `relative_factor == 1.0`, else
  *"Reference unit of measure is missing."* (`uom_uom.py:90-93`).

**Why `digits=0`?** Deliberate unlimited precision. The regression test
`tests/test_uom.py:22-27` documents it: if Dozen's `1/12` factor were stored as a float,
`1 Dozen → Units` could become `12.00000000000047` and the default 'UP' rounding would
inflate it to **13**.

## 3. Conversion math

### Quantity — `_compute_quantity(qty, to_unit, round=True, rounding_method='UP', ...)`
`uom_uom.py:136-166`:

```
amount = qty × self.factor ÷ to_unit.factor        # via absolute factors
amount = float_round(amount, digits=precision('Product Unit'), method)
```

- Precision comes from the `decimal.precision` named **"Product Unit"** (default **2 digits**,
  `data/uom_data.xml:6-9`).
- Default rounding for quantities is **'UP'** — conversions never under-deliver
  (confirmed by `test_20_rounding`: `2 Units → Score(20×)` = `0.1` rounds to **1**).
- Same-unit fast path returns `qty` untouched (no rounding) — `test_30_quantity`.
- ⚠️ **The `raise_if_failure` parameter is dead code in 20.0**: the docstring still promises
  a cross-category error (`uom_uom.py:147-149`), but the body performs **no tree-compatibility
  check** — a cross-tree call silently computes `qty × factor_a ÷ factor_b`. Tree checks live
  in callers that care (see `_has_common_reference` below). Several mrp callers still pass
  `raise_if_failure=False` (`addons/mrp/models/product.py:292`) — legacy signature.

### Price — `_compute_price(price, to_unit)` `uom_uom.py:186-193`
Prices convert **inversely** to quantities: `per_unit_price × to_unit.factor ÷ self.factor`
(2 €/g → 2,000,000 €/t; `test_uom.py:29-30`). No rounding applied.

### Helpers
- `round(value, method='HALF-UP')`, `compare(a, b)`, `is_zero(v)` — all at "Product Unit"
  precision (`uom_uom.py:108-127`).
- `_check_qty(product_qty, uom_id, rounding_method)` (`uom_uom.py:168-183`): snaps a
  quantity to whole multiples of a packaging unit without float-modulo traps.
- `_has_common_reference(other)` (`uom_uom.py:208-220`): compares `parent_path` prefixes —
  the *only* structural convertibility test (used by mrp per-unit printing
  `mrp_production.py:3231`, label wizards `stock/wizard/product_label_layout.py:62`).

## 4. Shipped master data (`data/uom_data.xml`, `noupdate="1"`)

Five trees (root = the unit with no parent, `factor 1`):

| Tree (root) | Units (relative_factor vs parent) |
|---|---|
| **Units** | Pack of 6 = 6 Units; Dozens = 12 Units *(archived)* |
| **Working time** (Hour) | Day = 8 h; Minute = 0.0166667 h |
| **Length** (mm) | cm = 10 mm *(archived)*; m = 100 cm; km = 1000 m; in = 2.54 cm; ft = 12 in; yd = 3 ft; mile = 1760 yd |
| **Volume** (ml) | L = 1000 ml; m³ = 1000 L; *(ft³ tree likewise)* |
| **Weight** (g) | kg = 1000 g; t = 1000 kg; oz = 28.3495 g; lb = 16 oz |
| **Surface** (m²) | standalone root |

Note `Day = 8 h` — Odoo's "working day", not 24 h.

## 5. Master-data protection & lifecycle

- **Protected records**: any `uom.uom` whose XML ID comes from module `uom` cannot be
  deleted (`@api.ondelete` → UserError "…cannot be deleted: %s — You can archive them
  instead", `uom_uom.py:98-106`) except the allowlist `product_uom_hour`,
  `product_uom_dozen`, `product_uom_pack_6` (`uom_uom.py:24-34`). Detection goes through
  `ir.model.data` (`_filter_protected_uoms`, `uom_uom.py:195-205`).
- **Editing warning**: changing `relative_factor` on an old protected unit raises an onchange
  warning — existing records are *not* rescaled; the change is live-only
  (`_onchange_critical_fields`, `uom_uom.py:72-88`).
- Deleting a parent cascades to children (`relative_uom_id ondelete='cascade'`).

## 6. Product integration (`addons/product`)

- `product.template.uom_id` — required, tracked, default `uom.product_uom_unit`, help:
  *"Default unit of measure used for all stock operations."*
  (`product_template.py:167-170`).
- `product.template.uom_ids` — many2many **"Packagings"**: extra units usable in sales,
  domain excludes `uom_id` (`product_template.py:171`).
- `product.product.extra_uom_ids` — variant-level extras, propagated to new variants
  (`product_template.py:1112-1215`).
- **`uom_po_id` is gone** in 20.0 — zero occurrences anywhere. Purchase lines now pick their
  unit from the allowed-UOM domain like sales does.
- **Allowed-UOM rule** (`_get_available_uoms`, `product_template.py:1866-1873`):
  - feature group **`uom.group_uom`** ("Manage Multiple Units of Measure",
    `security/uom_security.xml`) **disabled** → only the product's `uom_id`;
  - enabled → `uom_id | uom_ids` (+ `extra_uom_ids` per variant, `product_product.py:1456-1461`).
- **Changing a product's UOM** shows a hard warning: conversion is `1 old = 1 new` and
  existing documents keep their numbers with only the *unit name* swapped
  (`_onchange_uom_id`, `product_template.py:697-711`); the warning appears only if history
  exists (`_trigger_uom_warning` base returns False; purchase overrides it to True when the
  product appears on any PO — `purchase/models/product.py:186-193`). `_update_uom` is the
  hook modules use to rewrite dependent rows without recomputation
  (`product_product.py:1446-1449`).
- **Physical-property units** are config-driven: `product.weight_in_lbs=1` switches weight
  display to lb (else kg), `product.volume_in_cubic_feet=1` switches length→feet and
  volume→ft³ (else mm and m³) (`product_template.py:572-610`).

## 7. Business-app integration

| App | Unit field | Allowed units | Notable behavior |
|---|---|---|---|
| **Sale** | `sale.order.line.product_uom_id` | `product._get_available_uoms()` (`sale_order_line.py:710-712`), domain gated by `allowed_uom_ids` (`:166`) | DB CHECKs require a unit on real lines (`:25-33`) |
| **Purchase** | `purchase.order.line.uom_id`, `ondelete='restrict'` | product UOMs **+ vendor-specific seller UOMs** (`purchase_order_line.py:537-541`) | `price_unit_product_uom` recomputes the price in the product's base unit via `_compute_price` (`:205-208`); invoice reconciliation converts with `_compute_quantity(..., round=False)` (`:268`) |
| **Stock** | `stock.move.uom_id` | product UOMs | `quantity_product_uom` mirrors done-qty into product units at `HALF-UP` (`stock_move.py:268, 1973, 2037`) |
| **MRP** | BoM line/production UOMs | product UOMs **+ BoM UOMs** (`mrp_production.py:456`) | kit math passes `raise_if_failure=False` (`mrp/models/product.py:292`) |

Rounding convention summary: **quantities default 'UP'** (never short-ship), stock's
product-unit mirror uses **'HALF-UP'**, packaging snaps use caller-chosen methods.

## 8. Security & UI

- One feature group: `uom.group_uom` "Manage Multiple Units of Measure"
  (`security/uom_security.xml`), registered as a "light" group (`models/res_groups.py`).
- Views show `relative_factor` as "Contains/Quantity" with hidden-when-1 logic and lock
  editing when opened from a product context (`views/uom_uom_views.xml:10, 25-27`).
- Web client widgets `many2one_uom` / `many2x_uom_tags`
  (`static/src/components/`) render inline UOM pickers; the catalog mixin exposes
  `availableUoms` to the product catalog (`product_catalog_mixin.py:153`).

## 9. Behavior spec (from `tests/test_uom.py`)

1. `1,020,000 g → 1.02 t`; `2 €/g → 2,000,000 €/t` (exact factor math).
2. `1 Dozen → 12 Units` exactly (precision regression, see §2).
3. `1,234 g → 1.24 kg` — evidence that quantity conversion **rounds UP** by default
   (1.234 → 1.24).
4. `2 Units → Score(20×)` with 0-digit precision → `1` ("rounded up").
5. `_check_qty` must not touch quantities when unit == packaging unit.

## 10. Design observations & pitfalls

1. **Convertibility is structural, not declared** — grafting `in` under `cm` shows the
   design intent (one tree per dimension), but nothing *prevents* creating a foreign root
   and converting across trees; `_compute_quantity` will happily compute garbage ratios.
   Safety checks are opt-in at call sites (`_has_common_reference`).
2. **Dead `raise_if_failure`** — the cross-category contract described in its docstring no
   longer exists in the body; external code should not rely on it raising.
3. **'UP' rounding default** is a business policy (round in the customer's favor on
   quantities); it multiplies with low "Product Unit" precision — e.g. small unit
   conversions inflate (test 4 above). Configurable per call and via decimal precision.
4. **Changing a product's UOM is a foot-gun** — Odoo rescales *nothing*; it swaps unit
   names on historical documents (1 old = 1 new). The warning exists precisely because the
   data model keeps quantities denominated in the line's unit.
5. **Root lock**: roots are forced to factor 1.0 and master data is protected from
   deletion — the tree's absolute anchors cannot drift silently.
6. **`Day = 8h`** and other odd factors (minute = 0.0166667 h) are business defaults, not
   physics; they live in `noupdate` data and can be customized.

## 11. REA's role

This analysis is *source-level* (REA's domain is source-less artifact analysis). REA can
add value on Odoo 20 in other ways: static analysis of the shipped **web client JS bundle**
around UOM widgets, `.pyc`/frozen-distribution recovery, or evidence-backed comparison of a
deployed instance's artifacts against this source baseline — all local, no credentials.
